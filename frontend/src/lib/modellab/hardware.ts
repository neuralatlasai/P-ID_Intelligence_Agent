/**
 * Simulated accelerator telemetry for the model lab's training run.
 *
 * No GPU cluster is connected to this application. The figures here are what the cluster a
 * run configuration describes would plausibly report: utilisation near saturation while
 * training and near idle while paused, memory at the planning estimate's per-GPU peak,
 * temperatures and board power that follow utilisation, and cluster throughput that wobbles a
 * few per cent around the planning estimate. An occasional straggler rank and thermal hot spot
 * appear the way they do on real fleets.
 *
 * Every value is a pure function of (profile, config, steps/s, running, now). Noise is keyed
 * by node, GPU and a 5-second time bucket, so two viewers at the same moment agree, a paused
 * run is frozen and a test can reproduce any sample exactly.
 */

import { hashString } from "@/lib/canvas/engineering";

import type { RunConfig, RunProfile } from "./config";

/** Board power limit (TDP) per accelerator, watts. */
export const ACCELERATOR_TDP_W: Readonly<Record<string, number>> = {
  h100: 700,
  h200: 700,
  b200: 1000,
  a100: 400,
  l40s: 350,
};

/** Telemetry refreshes on this cadence, as a metrics exporter would scrape it. */
export const TELEMETRY_BUCKET_MS = 5_000;

export interface GpuSample {
  readonly node: number;
  readonly gpu: number;
  readonly utilPct: number;
  readonly memUsedGb: number;
  readonly memTotalGb: number;
  readonly tempC: number;
  readonly powerW: number;
  /** A rank running noticeably below its peers this window. */
  readonly straggler: boolean;
  /** A GPU running hotter than its peers this window. */
  readonly hot: boolean;
}

export interface NodeTelemetry {
  readonly index: number;
  /** "node-01" … */
  readonly name: string;
  readonly gpus: readonly GpuSample[];
  readonly avgUtilPct: number;
  readonly maxTempC: number;
  readonly powerW: number;
  readonly memUsedGb: number;
}

export type InterconnectState = "active" | "idle";

export interface InterconnectTelemetry {
  readonly state: InterconnectState;
  /** Intra-node fabric, e.g. "NVLink 4". */
  readonly intraNode: string;
  /** Inter-node fabric, or undefined for a single node. */
  readonly interNode?: string;
  /** Per-node inter-node link capacity, Gbit/s (0 for a single node). */
  readonly linkGbps: number;
  /** Gradient all-reduce traffic per node, Gbit/s. */
  readonly trafficGbps: number;
}

export interface ClusterTelemetry {
  readonly simulated: true;
  readonly bucket: number;
  readonly nodes: readonly NodeTelemetry[];
  readonly gpuCount: number;
  readonly avgUtilPct: number;
  readonly samplesPerSecond: number;
  readonly tokensPerSecond: number;
  readonly stepsPerSecond: number;
  readonly powerKw: number;
  readonly maxTempC: number;
  readonly interconnect: InterconnectTelemetry;
  readonly straggler?: GpuSample;
  readonly hotSpot?: GpuSample;
}

/** Deterministic noise in [-1, 1) for a key. */
function noise(key: string): number {
  return (hashString(key) / 4294967296) * 2 - 1;
}

/** Deterministic value in [0, 1) for a key. */
function unit(key: string): number {
  return hashString(key) / 4294967296;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const round1 = (value: number) => Math.round(value * 10) / 10;

const FABRICS: Readonly<
  Record<string, { intra: string; inter: string; gbps: number; nicsPerNode: number }>
> = {
  h100: { intra: "NVLink 4", inter: "InfiniBand NDR", gbps: 400, nicsPerNode: 8 },
  h200: { intra: "NVLink 4", inter: "InfiniBand NDR", gbps: 400, nicsPerNode: 8 },
  b200: { intra: "NVLink 5", inter: "InfiniBand XDR", gbps: 800, nicsPerNode: 8 },
  a100: { intra: "NVLink 3", inter: "InfiniBand HDR", gbps: 200, nicsPerNode: 8 },
  l40s: { intra: "PCIe Gen4", inter: "RoCE v2", gbps: 200, nicsPerNode: 2 },
};

/**
 * Where the straggler and hot spot sit: they persist for a few minutes, then move on or clear,
 * rather than flickering between scrapes.
 */
function incidents(
  config: RunConfig,
  now: number,
): {
  straggler?: { node: number; gpu: number; depth: number };
  hot?: { node: number; gpu: number; excess: number };
} {
  const nodes = Math.max(1, config.nodes);
  const gpus = Math.max(1, config.gpusPerNode);
  const window = Math.floor(now / 180_000);
  const seed = `${config.accelerator}:${nodes}x${gpus}:${window}`;
  const result: ReturnType<typeof incidents> = {};
  if (unit(`straggler?:${seed}`) < 0.35) {
    result.straggler = {
      node: Math.floor(unit(`straggler-node:${seed}`) * nodes),
      gpu: Math.floor(unit(`straggler-gpu:${seed}`) * gpus),
      depth: 0.18 + 0.12 * unit(`straggler-depth:${seed}`),
    };
  }
  const hotWindow = Math.floor(now / 420_000);
  const hotSeed = `${config.accelerator}:${nodes}x${gpus}:${hotWindow}`;
  if (unit(`hot?:${hotSeed}`) < 0.45) {
    result.hot = {
      node: Math.floor(unit(`hot-node:${hotSeed}`) * nodes),
      gpu: Math.floor(unit(`hot-gpu:${hotSeed}`) * gpus),
      excess: 5 + 3 * unit(`hot-excess:${hotSeed}`),
    };
  }
  return result;
}

/**
 * Telemetry for every GPU in the configured cluster, plus cluster aggregates.
 *
 * `stepsPerSecond` is the run's optimiser step rate (the effective stage's); `profile` supplies
 * the samples/s, tokens per sample and per-GPU memory the planning estimate predicts.
 */
export function gpuTelemetry(
  profile: RunProfile,
  config: RunConfig,
  stepsPerSecond: number,
  running: boolean,
  now: number,
): ClusterTelemetry {
  const bucket = Math.floor(now / TELEMETRY_BUCKET_MS);
  const nodeCount = Math.max(1, Math.floor(config.nodes));
  const gpusPerNode = Math.max(1, Math.floor(config.gpusPerNode));
  const accelerator = profile.accelerator;
  const tdp = ACCELERATOR_TDP_W[accelerator.id] ?? 700;
  const memTotalGb = accelerator.memoryGb;
  const { straggler, hot } = running ? incidents(config, now) : {};

  const nodes: NodeTelemetry[] = [];
  let allSamples: GpuSample[] = [];
  for (let n = 0; n < nodeCount; n += 1) {
    const gpus: GpuSample[] = [];
    for (let g = 0; g < gpusPerNode; g += 1) {
      const key = `${n}:${g}:${bucket}`;
      const isStraggler = straggler?.node === n && straggler.gpu === g;
      const isHot = hot?.node === n && hot.gpu === g;

      const utilPct = running
        ? clamp(
            (isStraggler ? 94 * (1 - straggler.depth) : 94) + 3 * noise(`util:${key}`),
            0,
            100,
          )
        : 5.5 + 2.5 * noise(`idle-util:${key}`);

      // Weights, optimiser shards and the activation pool stay allocated while paused.
      const memUsedGb = Math.min(
        memTotalGb,
        profile.memoryPerGpuGb * (1 + 0.02 * noise(`mem:${key}`)),
      );

      // Board temperature tracks utilisation; each GPU has its own offset (airflow position).
      const seat = 2 * noise(`seat:${n}:${g}`);
      const tempC = running
        ? isHot
          ? clamp(76 + hot.excess + noise(`temp:${key}`), 79, 86)
          : clamp(62 + ((utilPct - 60) / 40) * 12 + seat + noise(`temp:${key}`), 62, 78)
        : clamp(38 + seat + noise(`temp:${key}`), 33, 45);

      const powerW = running
        ? Math.min(
            tdp,
            tdp * (0.12 + 0.84 * (utilPct / 100)) * (1 + 0.02 * noise(`pw:${key}`)),
          )
        : tdp * (0.085 + 0.01 * noise(`idle-pw:${key}`));

      gpus.push({
        node: n,
        gpu: g,
        utilPct: round1(utilPct),
        memUsedGb: round1(memUsedGb),
        memTotalGb,
        tempC: Math.round(tempC),
        powerW: Math.round(powerW),
        straggler: Boolean(isStraggler),
        hot: Boolean(isHot),
      });
    }
    nodes.push({
      index: n,
      name: `node-${String(n + 1).padStart(2, "0")}`,
      gpus,
      avgUtilPct: round1(gpus.reduce((sum, gpu) => sum + gpu.utilPct, 0) / gpus.length),
      maxTempC: Math.max(...gpus.map((gpu) => gpu.tempC)),
      powerW: gpus.reduce((sum, gpu) => sum + gpu.powerW, 0),
      memUsedGb: round1(gpus.reduce((sum, gpu) => sum + gpu.memUsedGb, 0)),
    });
    allSamples = allSamples.concat(gpus);
  }

  // Synchronous data parallelism: every rank waits for the slowest, so a straggler costs the
  // whole cluster a little throughput.
  const wobble = running
    ? 1 + 0.03 * noise(`cluster:${bucket}`) - (straggler ? 0.015 : 0)
    : 0;
  const samplesPerSecond = profile.samplesPerSecond * wobble;
  const liveSteps = stepsPerSecond * wobble;

  const fabric = FABRICS[accelerator.id] ?? FABRICS.h100!;
  const multiNode = nodeCount > 1;
  const linkGbps = multiNode ? fabric.gbps * fabric.nicsPerNode : 0;
  // Ring all-reduce of bf16 gradients for the trainable parameters, 2(n-1)/n of the payload.
  const gradientBytes = profile.trainableB * 1e9 * 2;
  const ranks = nodeCount * gpusPerNode;
  const perStepBytes = gradientBytes * ((2 * (ranks - 1)) / ranks);
  const trafficGbps =
    running && multiNode
      ? Math.min(
          linkGbps * 0.9,
          ((perStepBytes * 8) / 1e9) * profile.stepsPerSecond * wobble,
        )
      : 0;

  const powerW = allSamples.reduce((sum, gpu) => sum + gpu.powerW, 0);
  return {
    simulated: true,
    bucket,
    nodes,
    gpuCount: allSamples.length,
    avgUtilPct: round1(
      allSamples.reduce((sum, gpu) => sum + gpu.utilPct, 0) / allSamples.length,
    ),
    samplesPerSecond,
    tokensPerSecond: samplesPerSecond * profile.tokensPerSample,
    stepsPerSecond: liveSteps,
    powerKw: powerW / 1000,
    maxTempC: Math.max(...allSamples.map((gpu) => gpu.tempC)),
    interconnect: {
      state: running ? "active" : "idle",
      intraNode: fabric.intra,
      interNode: multiNode
        ? `${fabric.inter} ${fabric.gbps}G ×${fabric.nicsPerNode}`
        : undefined,
      linkGbps,
      trafficGbps,
    },
    straggler: allSamples.find((gpu) => gpu.straggler),
    hotSpot: allSamples.find((gpu) => gpu.hot),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Draft configuration helpers
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Fields that differ between the applied and the draft configuration. */
export function configChanges(applied: RunConfig, draft: RunConfig): (keyof RunConfig)[] {
  return (Object.keys(applied) as (keyof RunConfig)[]).filter(
    (key) => applied[key] !== draft[key],
  );
}

/**
 * The step rate a draft would run at. The applied run's rate is scaled by the ratio of the two
 * planning estimates, so the draft figure stays consistent with whatever the live run shows.
 */
export function draftStepsPerSecond(
  appliedStepsPerSecond: number,
  appliedProfile: RunProfile,
  draftProfile: RunProfile,
): number {
  if (appliedProfile.stepsPerSecond <= 0) return draftProfile.stepsPerSecond;
  return (
    appliedStepsPerSecond * (draftProfile.stepsPerSecond / appliedProfile.stepsPerSecond)
  );
}

/** Seconds to finish the remaining steps at a step rate; Infinity when the rate is zero. */
export function etaSeconds(
  totalSteps: number,
  step: number,
  stepsPerSecond: number,
): number {
  const remaining = Math.max(0, totalSteps - step);
  if (remaining === 0) return 0;
  return stepsPerSecond > 0 ? remaining / stepsPerSecond : Number.POSITIVE_INFINITY;
}

/** A compact duration for ETAs: "3d 4h", "5h 12m", "12m", "<1m". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "done";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Compact rate: 412, 9.3K, 1.24M. */
export function formatRate(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
