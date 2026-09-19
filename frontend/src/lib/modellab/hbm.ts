/**
 * Per-GPU HBM plan: who owns each gigabyte of one accelerator's memory, at the phase the run
 * is in now.
 *
 * Weights, gradients, optimizer state and activations come straight from
 * `config.memoryBreakdown` — the formula `runProfile` takes its fits verdict from — so the
 * stacked bar and the verdict can never disagree.
 *
 * The one addition is the KV cache. Training stages run no autoregressive decode, so they hold
 * none. Reinforcement learning does: verl's colocated rollout engine (vLLM) generates each
 * GRPO group on the same GPUs as the FSDP actor, and its paged KV pool lives in the memory the
 * actor's activations release between updates. The activation slot is therefore time-shared —
 * KV while `gen` runs, activations while the log-prob and update passes run — and the pool is
 * capped at that slot. When the group's KV demand exceeds it, the engine preempts and
 * recomputes sequences rather than allocate past the plan; `kvPreempting` says so.
 */

import {
  BACKBONES,
  GROUP_SIZE,
  memoryBreakdown,
  type RunConfig,
  type RunProfile,
} from "./config";
import type { StageId } from "./stages";

/**
 * Attention KV geometry of each backbone's language model, from its published config:
 * decoder layers, KV heads (grouped-query attention) and head dimension.
 */
const KV_GEOMETRY: Readonly<Record<string, readonly [number, number, number]>> = {
  "qwen3-vl-32b": [64, 8, 128],
  "qwen3-vl-30b-a3b": [48, 4, 128],
  "qwen3-vl-8b": [36, 8, 128],
  "qwen2.5-vl-72b": [80, 8, 128],
  "internvl3-38b": [64, 8, 128],
  "llama-3.2-90b-vision": [100, 8, 128],
  "gemma-3-27b": [62, 16, 128],
};

/** BF16 K and V for every layer, bytes per token. */
export function kvBytesPerToken(backboneId: string): number {
  const [layers, heads, dim] = KV_GEOMETRY[backboneId] ?? KV_GEOMETRY["qwen3-vl-32b"]!;
  return 2 * layers * heads * dim * 2;
}

export type HbmOwner = "frozen" | "weights" | "grads" | "optimizer" | "activations" | "kv";

export interface HbmSegment {
  readonly id: HbmOwner;
  /** Short mono label. */
  readonly label: string;
  readonly gb: number;
}

export interface HbmPlan {
  /** Stack order, bottom of the address space first. Zero-sized owners are kept. */
  readonly segments: readonly HbmSegment[];
  readonly totalGb: number;
  readonly capacityGb: number;
  /** Planning limit: 92 % of capacity, the threshold `runProfile().fits` uses. */
  readonly limitGb: number;
  readonly fits: boolean;
  /** The time-shared slot holds the rollout KV pool right now. */
  readonly kvLive: boolean;
  /** The time-shared activation / KV slot, GB: the activation allowance. */
  readonly slotGb: number;
  /** KV the rollout group would need per GPU, GB (0 outside reinforcement learning). */
  readonly kvDemandGb: number;
  /** Demand exceeds the pool: the rollout engine preempts sequences. */
  readonly kvPreempting: boolean;
}

/**
 * The plan for `stage` under `config`. `phase` is the step phase executing now (telemetry
 * `PHASES` ids); the KV pool occupies the shared slot only during `gen`.
 */
export function hbmPlan(
  stage: StageId,
  config: RunConfig,
  profile: Pick<RunProfile, "accelerator" | "tokensPerSample" | "gpus">,
  phase?: string,
): HbmPlan {
  const memory = memoryBreakdown(stage, config);
  const capacityGb = profile.accelerator.memoryGb;
  let kvDemandGb = 0;
  if (stage === "rl") {
    const backbone = BACKBONES.find((item) => item.id === config.backbone) ?? BACKBONES[0]!;
    const sequencesPerGpu = (config.globalBatch * GROUP_SIZE) / Math.max(1, profile.gpus);
    const tokensPerSequence = profile.tokensPerSample / GROUP_SIZE;
    kvDemandGb = (sequencesPerGpu * tokensPerSequence * kvBytesPerToken(backbone.id)) / 1e9;
  }
  const kvLive = stage === "rl" && phase === "gen";
  const pool = Math.min(kvDemandGb, memory.activationGb);
  const segments: HbmSegment[] = [
    { id: "frozen", label: "frozen W", gb: memory.frozenGb },
    { id: "weights", label: "W", gb: memory.weightsGb },
    { id: "grads", label: "∇W", gb: memory.gradientsGb },
    { id: "optimizer", label: "AdamW m,v,W32", gb: memory.optimizerGb },
    { id: "activations", label: "act", gb: kvLive ? 0 : memory.activationGb },
    { id: "kv", label: "KV", gb: kvLive ? pool : 0 },
  ];
  // The shared slot is sized by the activation allowance either way, so the peak — and the
  // verdict — is the breakdown's total.
  const totalGb = memory.totalGb;
  return {
    segments,
    totalGb,
    capacityGb,
    limitGb: capacityGb * 0.92,
    fits: totalGb <= capacityGb * 0.92,
    kvLive,
    slotGb: memory.activationGb,
    kvDemandGb,
    kvPreempting: kvDemandGb > memory.activationGb,
  };
}
