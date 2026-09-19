/**
 * Run configuration and the planning estimates that follow from it.
 *
 * Choosing a backbone, an accelerator, a node count or a precision changes what a run costs
 * and how long it takes. Those consequences are computed here with the standard transformer
 * training estimate — about 6·N FLOPs per token for full fine-tuning (Kaplan et al. 2020;
 * Chinchilla), about 4·N when the backbone is frozen and only adapters and projectors train —
 * divided into the accelerators' throughput at a stated model FLOPs utilisation (MFU).
 * Memory uses the usual mixed-precision accounting: 16 bytes per trainable parameter for
 * weights, gradients and Adam state, sharded across GPUs by ZeRO-3, plus bf16 frozen weights
 * and a checkpointed activation allowance.
 *
 * These are planning estimates, labelled as such in the page. The catalogue figures are the
 * published model sizes and context lengths; accelerator FLOP rates are nominal bf16 figures.
 */

import { hashString } from "@/lib/canvas/engineering";

import type { StageId } from "./stages";

export interface Backbone {
  readonly id: string;
  readonly name: string;
  /** Total parameters, billions. */
  readonly params: number;
  /** Parameters active per token, billions (differs from total for mixture-of-experts). */
  readonly active: number;
  readonly contextK: number;
  readonly family: string;
}

export const BACKBONES: readonly Backbone[] = [
  {
    id: "qwen3-vl-32b",
    name: "Qwen3-VL-32B",
    params: 33,
    active: 33,
    contextK: 256,
    family: "Qwen3-VL",
  },
  {
    id: "qwen3-vl-30b-a3b",
    name: "Qwen3-VL-30B-A3B (MoE)",
    params: 31,
    active: 3.3,
    contextK: 256,
    family: "Qwen3-VL",
  },
  {
    id: "qwen3-vl-8b",
    name: "Qwen3-VL-8B",
    params: 8.8,
    active: 8.8,
    contextK: 256,
    family: "Qwen3-VL",
  },
  {
    id: "qwen2.5-vl-72b",
    name: "Qwen2.5-VL-72B",
    params: 73,
    active: 73,
    contextK: 128,
    family: "Qwen2.5-VL",
  },
  {
    id: "internvl3-38b",
    name: "InternVL3-38B",
    params: 38,
    active: 38,
    contextK: 32,
    family: "InternVL3",
  },
  {
    id: "llama-3.2-90b-vision",
    name: "Llama 3.2 90B Vision",
    params: 88,
    active: 88,
    contextK: 128,
    family: "Llama 3.2",
  },
  {
    id: "gemma-3-27b",
    name: "Gemma 3 27B",
    params: 27,
    active: 27,
    contextK: 128,
    family: "Gemma 3",
  },
];

export interface Encoder {
  readonly id: string;
  readonly name: string;
  /** Parameters, millions. */
  readonly paramsM: number;
}

export const SPATIAL_ENCODERS: readonly Encoder[] = [
  { id: "ptv3-uni3d", name: "Point Transformer V3 + Uni3D bridge", paramsM: 146 },
  { id: "ptv3", name: "Point Transformer V3", paramsM: 46 },
  { id: "uni3d-g", name: "Uni3D-g", paramsM: 1016 },
  { id: "none", name: "None (no 3D modality)", paramsM: 0 },
];

export const GRAPH_ENCODERS: readonly Encoder[] = [
  { id: "gt-xl", name: "Graph transformer (GPS layers, 480M)", paramsM: 480 },
  { id: "graphgps-l", name: "GraphGPS-L", paramsM: 64 },
  { id: "gat-v2", name: "GATv2 (3-layer)", paramsM: 12 },
  { id: "none", name: "None (topology as text)", paramsM: 0 },
];

export interface Accelerator {
  readonly id: string;
  readonly name: string;
  readonly memoryGb: number;
  /**
   * Dense BF16 tensor-core peak, FLOPs per second — the vendor datasheet figure without
   * structured sparsity. It is the MFU denominator, so it must be the same kind of number for
   * every device: a mix of peak and "effective" figures would make one device's MFU mean
   * something different from another's.
   */
  readonly flops: number;
  /** HBM bandwidth, bytes per second. Bounds decode throughput, which is memory-bound. */
  readonly bandwidth: number;
}

export const ACCELERATORS: readonly Accelerator[] = [
  { id: "h100", name: "H100 80GB", memoryGb: 80, flops: 9.89e14, bandwidth: 3.35e12 },
  { id: "h200", name: "H200 141GB", memoryGb: 141, flops: 9.89e14, bandwidth: 4.8e12 },
  { id: "b200", name: "B200 192GB", memoryGb: 192, flops: 2.25e15, bandwidth: 8e12 },
  { id: "a100", name: "A100 80GB", memoryGb: 80, flops: 3.12e14, bandwidth: 2.04e12 },
  { id: "l40s", name: "L40S 48GB", memoryGb: 48, flops: 3.62e14, bandwidth: 8.64e11 },
];

export type Precision = "bf16" | "fp8";
export type Trainable = "lora" | "full";

export interface RunConfig {
  readonly backbone: string;
  readonly spatial: string;
  readonly graph: string;
  readonly accelerator: string;
  readonly nodes: number;
  readonly gpusPerNode: number;
  readonly precision: Precision;
  readonly trainable: Trainable;
  readonly globalBatch: number;
}

/** What each stage ships with, matching its published recipe. */
export const DEFAULT_CONFIG: Record<StageId, RunConfig> = {
  // 4 × 8 ranks: a global batch of 256 is 8 sequences per rank per step.
  pretraining: {
    backbone: "qwen3-vl-32b",
    spatial: "ptv3-uni3d",
    graph: "gt-xl",
    accelerator: "h100",
    nodes: 4,
    gpusPerNode: 8,
    precision: "bf16",
    trainable: "lora",
    globalBatch: 256,
  },
  // 2 × 8 ranks: a global batch of 128 is 8 sequences per rank per step.
  sft: {
    backbone: "qwen3-vl-32b",
    spatial: "ptv3-uni3d",
    graph: "gt-xl",
    accelerator: "h100",
    nodes: 2,
    gpusPerNode: 8,
    precision: "bf16",
    trainable: "lora",
    globalBatch: 128,
  },
  rl: {
    backbone: "qwen3-vl-32b",
    spatial: "ptv3-uni3d",
    graph: "gt-xl",
    accelerator: "a100",
    nodes: 4,
    gpusPerNode: 8,
    precision: "bf16",
    trainable: "lora",
    globalBatch: 64,
  },
  distillation: {
    backbone: "qwen3-vl-8b",
    spatial: "ptv3",
    graph: "graphgps-l",
    accelerator: "h100",
    nodes: 1,
    gpusPerNode: 8,
    precision: "bf16",
    trainable: "full",
    globalBatch: 128,
  },
};

/** Completions sampled per prompt in the GRPO group. */
export const GROUP_SIZE = 8;
/** Prompt plus mean response, tokens, for one reinforcement-learning sequence. */
const RL_SEQUENCE_TOKENS = 2900;
/** Generation runs until the longest completion in the group ends. */
const RL_MAX_RESPONSE_TOKENS = 4096;
/** Active parameters of the frozen distillation teacher (Qwen3-VL-32B and encoders), billions. */
export const TEACHER_ACTIVE_B = 33.6;

/** Average tokens per training sample in each stage: images, drawing crops, graph text, answer. */
const TOKENS_PER_SAMPLE: Record<StageId, number> = {
  pretraining: 4096,
  sft: 3072,
  // A reinforcement-learning sample is one prompt group: GROUP_SIZE completions of a
  // ~1,850-token multimodal prompt and a ~1,050-token mean response.
  rl: 8 * RL_SEQUENCE_TOKENS,
  distillation: 2048,
};

export const MFU = 0.38;

export interface RunProfile {
  readonly backbone: Backbone;
  readonly spatial: Encoder;
  readonly graph: Encoder;
  readonly accelerator: Accelerator;
  readonly gpus: number;
  readonly trainableB: number;
  readonly tokensPerSample: number;
  readonly samplesPerSecond: number;
  readonly tokensPerSecond: number;
  readonly stepsPerSecond: number;
  /** Estimated peak memory per GPU, GB. */
  readonly memoryPerGpuGb: number;
  readonly fits: boolean;
  readonly gpuHoursPerKSteps: number;
}

const byId = <T extends { id: string }>(list: readonly T[], id: string): T =>
  list.find((item) => item.id === id) ?? list[0]!;

/**
 * Per-GPU memory, by owner. This is the one formula for training memory: `runProfile` takes
 * its peak from `totalGb`, so the stacked bar and the fits/doesn't-fit verdict can never
 * disagree.
 *
 * Trainable state is 16 bytes per parameter under mixed-precision AdamW — a BF16 weight
 * (2 B), a BF16 gradient (2 B) and FP32 master weight, first and second moment (12 B) —
 * sharded across every rank (FSDP2 full shard / ZeRO-3). Frozen weights are held once at
 * the weight precision and sharded the same way. Activations are per rank, not sharded.
 */
export interface MemoryBreakdown {
  /** Trainable parameters, billions. */
  readonly trainableB: number;
  /** Frozen weight shard, GB per GPU. */
  readonly frozenGb: number;
  /** Trainable BF16 weight shard, GB per GPU. */
  readonly weightsGb: number;
  /** BF16 gradient shard, GB per GPU. */
  readonly gradientsGb: number;
  /** FP32 master weights + AdamW moments, GB per GPU. */
  readonly optimizerGb: number;
  /** Checkpointed activations for one micro-batch sequence, GB per GPU. */
  readonly activationGb: number;
  readonly totalGb: number;
}

export function memoryBreakdown(stage: StageId, config: RunConfig): MemoryBreakdown {
  const backbone = byId(BACKBONES, config.backbone);
  const spatial = byId(SPATIAL_ENCODERS, config.spatial);
  const graph = byId(GRAPH_ENCODERS, config.graph);
  const gpus = Math.max(1, config.nodes * config.gpusPerNode);
  const encodersB = (spatial.paramsM + graph.paramsM) / 1000;
  // Trainable parameters: everything for a full fine-tune; otherwise LoRA adapters (≈1.5 %)
  // plus the modality encoders — except in reinforcement learning, where the policy's
  // encoders stay frozen and only the adapters take gradients.
  const encodersTrained = stage === "rl" ? 0 : encodersB;
  const trainableB =
    config.trainable === "full"
      ? backbone.params + encodersB
      : backbone.params * 0.015 + encodersTrained;
  const weightBytes = config.precision === "fp8" ? 1 : 2;
  const frozenGb =
    ((backbone.params +
      encodersB -
      (config.trainable === "full" ? backbone.params + encodersB : encodersTrained)) *
      weightBytes) /
    gpus;
  const trainedGb = (trainableB * 16) / gpus;
  const weightsGb = (trainableB * 2) / gpus;
  const gradientsGb = (trainableB * 2) / gpus;
  // Checkpointed activations for one micro-batch at the stage's sample length.
  // Activations are per micro-batch sequence, not per sample group.
  const sequenceTokens = stage === "rl" ? RL_SEQUENCE_TOKENS : TOKENS_PER_SAMPLE[stage];
  const activationGb = 6 + (sequenceTokens / 4096) * (backbone.active / 33) * 14;
  return {
    trainableB,
    frozenGb,
    weightsGb,
    gradientsGb,
    // The remainder of the 16 bytes, so the three parts sum to the trained total exactly.
    optimizerGb: trainedGb - weightsGb - gradientsGb,
    activationGb,
    totalGb: frozenGb + trainedGb + activationGb,
  };
}

/** Planning estimate for a configuration. Pure; O(1). */
export function runProfile(stage: StageId, config: RunConfig): RunProfile {
  const backbone = byId(BACKBONES, config.backbone);
  const spatial = byId(SPATIAL_ENCODERS, config.spatial);
  const graph = byId(GRAPH_ENCODERS, config.graph);
  const accelerator = byId(ACCELERATORS, config.accelerator);
  const gpus = Math.max(1, config.nodes * config.gpusPerNode);
  const encodersB = (spatial.paramsM + graph.paramsM) / 1000;

  // Active compute per token: the language backbone's active parameters plus the encoders.
  const activeB = backbone.active + encodersB;
  const updateFactor = config.trainable === "full" ? 6 : 4;
  // Distillation also runs the frozen teacher forward (2·N) on every student token.
  const teacherFlops = stage === "distillation" ? 2 * TEACHER_ACTIVE_B : 0;
  const flopsPerToken = (updateFactor * activeB + teacherFlops) * 1e9;
  // FP8 kernels raise effective throughput on accelerators that support them.
  const precisionGain =
    config.precision === "fp8" && accelerator.id !== "a100" && accelerator.id !== "l40s"
      ? 1.35
      : 1;
  const sustained = gpus * accelerator.flops * MFU * precisionGain;
  const tokensPerSample = TOKENS_PER_SAMPLE[stage];
  let stepSeconds: number;
  if (stage === "rl") {
    // A GRPO step is generation, then two forward passes (old and reference log-probs) and
    // the actor update over every generated token, then verification. Generation is
    // memory-bound: each decode step streams the weights once per tensor-parallel group, and
    // the step lasts until the longest completion hits its end.
    const weightsGb = backbone.params * 2;
    const tensorParallel = weightsGb > 40 ? 4 : weightsGb > 16 ? 2 : 1;
    const decodeSeconds =
      (weightsGb * 1e9) / (tensorParallel * accelerator.bandwidth * 0.55) + 0.01;
    const generation = RL_MAX_RESPONSE_TOKENS * decodeSeconds;
    const trainTokens = config.globalBatch * tokensPerSample;
    const training = (trainTokens * (4 + updateFactor) * activeB * 1e9) / sustained;
    const verification = 0.022 * config.globalBatch * GROUP_SIZE;
    stepSeconds = generation + training + verification;
  } else {
    stepSeconds = (config.globalBatch * tokensPerSample * flopsPerToken) / sustained;
  }
  const samplesPerSecond = config.globalBatch / stepSeconds;
  const tokensPerSecond = samplesPerSecond * tokensPerSample;

  const memory = memoryBreakdown(stage, config);
  const { trainableB } = memory;
  const memoryPerGpuGb = memory.totalGb;

  return {
    backbone,
    spatial,
    graph,
    accelerator,
    gpus,
    trainableB,
    tokensPerSample,
    samplesPerSecond,
    tokensPerSecond,
    stepsPerSecond: samplesPerSecond / config.globalBatch,
    memoryPerGpuGb,
    fits: memoryPerGpuGb <= accelerator.memoryGb * 0.92,
    gpuHoursPerKSteps: (gpus * 1000) / (samplesPerSecond / config.globalBatch) / 3600,
  };
}

/** A run's identity follows from its configuration and the moment it was applied. */
export function experimentId(stage: StageId, config: RunConfig, appliedAt: number): string {
  const date = new Date(appliedAt).toISOString().slice(0, 10);
  const digest = hashString(`${stage}:${JSON.stringify(config)}`)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 6);
  const prefix = { pretraining: "pt", sft: "sft", rl: "rl", distillation: "kd" }[stage];
  return `exp-${date}-${prefix}-${digest}`;
}

export function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
