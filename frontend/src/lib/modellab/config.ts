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
  { id: "gt-xl", name: "Graph Transformer (GT-XL)", paramsM: 480 },
  { id: "graphgps-l", name: "GraphGPS-L", paramsM: 64 },
  { id: "gat-v2", name: "GATv2 (3-layer)", paramsM: 12 },
  { id: "none", name: "None (topology as text)", paramsM: 0 },
];

export interface Accelerator {
  readonly id: string;
  readonly name: string;
  readonly memoryGb: number;
  /** Nominal bf16 training throughput, FLOPs per second. */
  readonly flops: number;
}

export const ACCELERATORS: readonly Accelerator[] = [
  { id: "h100", name: "H100 80GB", memoryGb: 80, flops: 5.6e14 },
  { id: "h200", name: "H200 141GB", memoryGb: 141, flops: 5.6e14 },
  { id: "b200", name: "B200 192GB", memoryGb: 192, flops: 1.2e15 },
  { id: "a100", name: "A100 80GB", memoryGb: 80, flops: 3.12e14 },
  { id: "l40s", name: "L40S 48GB", memoryGb: 48, flops: 2.1e14 },
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
  pretraining: {
    backbone: "qwen3-vl-32b",
    spatial: "ptv3-uni3d",
    graph: "gt-xl",
    accelerator: "h100",
    nodes: 3,
    gpusPerNode: 8,
    precision: "bf16",
    trainable: "lora",
    globalBatch: 256,
  },
  sft: {
    backbone: "qwen3-vl-32b",
    spatial: "ptv3-uni3d",
    graph: "gt-xl",
    accelerator: "h100",
    nodes: 3,
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

/** Average tokens per training sample in each stage: images, drawing crops, graph text, answer. */
const TOKENS_PER_SAMPLE: Record<StageId, number> = {
  pretraining: 4096,
  sft: 3072,
  // A rollout is generated, scored and then trained on: roughly three passes of its tokens.
  rl: 6144 * 1.5,
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
  const flopsPerToken = (config.trainable === "full" ? 6 : 4) * activeB * 1e9;
  // FP8 kernels raise effective throughput on accelerators that support them.
  const precisionGain =
    config.precision === "fp8" && accelerator.id !== "a100" && accelerator.id !== "l40s"
      ? 1.35
      : 1;
  const tokensPerSecond = (gpus * accelerator.flops * MFU * precisionGain) / flopsPerToken;
  const tokensPerSample = TOKENS_PER_SAMPLE[stage];
  const samplesPerSecond = tokensPerSecond / tokensPerSample;

  // Trainable parameters: everything for a full fine-tune; adapters (≈1.5 %) plus encoders otherwise.
  const trainableB =
    config.trainable === "full"
      ? backbone.params + encodersB
      : backbone.params * 0.015 + encodersB;
  const weightBytes = config.precision === "fp8" ? 1 : 2;
  const frozenGb =
    ((backbone.params +
      encodersB -
      (config.trainable === "full" ? backbone.params + encodersB : encodersB)) *
      weightBytes) /
    gpus;
  const trainedGb = (trainableB * 16) / gpus;
  // Checkpointed activations for one micro-batch at the stage's sample length.
  const activationGb = 6 + (tokensPerSample / 4096) * (backbone.active / 33) * 14;
  const memoryPerGpuGb = frozenGb + trainedGb + activationGb;

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
