/**
 * Simulated accelerator telemetry for the model lab's training run.
 *
 * No GPU cluster is connected to this application. The figures here are what the cluster a
 * run configuration describes would plausibly report: utilisation near saturation while
 * training and near idle while paused, memory at the planning estimate's per-GPU peak,
 * temperatures and board power that follow utilisation, and cluster throughput that wobbles a
 * few per cent around the planning estimate. A thermal hot spot appears now and then, the way
 * it does on real fleets.
 *
 * A straggling rank is not invented here: it is read from the run's incident timeline
 * (incidents.ts), the record the run console's step-time chart and log also read. A GPU is
 * shown lagging exactly while a `straggler` incident is in effect at the current step, and it
 * is the rank that incident names — so the heatmap, the chart marker and the log line
 * "rank 13 (node-02) is a straggler" always point at the same device. Without a timeline no
 * straggler is shown.
 *
 * Every value is a pure function of (profile, config, steps/s, running, now, timeline). Noise
 * is keyed by node, GPU and a 5-second time bucket, so two viewers at the same moment agree, a
 * paused run is frozen and a test can reproduce any sample exactly.
 */

import { hashString } from "@/lib/canvas/engineering";

import type { RunConfig, RunProfile } from "./config";
import { activeIncidents, envelope, rankOf, type Incident } from "./incidents";
import type { Stage } from "./stages";

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

/** A GPU above this board temperature is flagged hot. */
export const HOT_TEMP_C = 79;

export interface GpuSample {
  readonly node: number;
  readonly gpu: number;
  /** Global rank: node × GPUs per node + local index. */
  readonly rank: number;
  readonly utilPct: number;
  readonly memUsedGb: number;
  readonly memTotalGb: number;
  readonly tempC: number;
  readonly powerW: number;
  /** The rank a `straggler` incident on the run timeline names at the current step. */
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
  /** The timeline incident the straggler is read from. */
  readonly stragglerIncident?: Incident;
  readonly hotSpot?: GpuSample;
}

/** Where the run is on its incident timeline: the effective stage and the current step. */
export interface TelemetryTimeline {
  readonly stage: Pick<Stage, "id" | "run">;
  readonly step: number;
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

export interface FabricSpec {
  readonly intra: string;
  readonly inter: string;
  /** Per-NIC inter-node bandwidth, Gbit/s. */
  readonly gbps: number;
  readonly nicsPerNode: number;
  /** Per-GPU intra-node bandwidth, GB/s, one direction. */
  readonly intraGBps: number;
}

export const FABRICS: Readonly<Record<string, FabricSpec>> = {
  h100: {
    intra: "NVLink 4",
    inter: "InfiniBand NDR",
    gbps: 400,
    nicsPerNode: 8,
    intraGBps: 450,
  },
  h200: {
    intra: "NVLink 4",
    inter: "InfiniBand NDR",
    gbps: 400,
    nicsPerNode: 8,
    intraGBps: 450,
  },
  b200: {
    intra: "NVLink 5",
    inter: "InfiniBand XDR",
    gbps: 800,
    nicsPerNode: 8,
    intraGBps: 900,
  },
  a100: {
    intra: "NVLink 3",
    inter: "InfiniBand HDR",
    gbps: 200,
    nicsPerNode: 8,
    intraGBps: 300,
  },
  l40s: { intra: "PCIe Gen4", inter: "RoCE v2", gbps: 200, nicsPerNode: 2, intraGBps: 32 },
};

/** The fabric an accelerator ships with. */
export function fabricOf(acceleratorId: string): FabricSpec {
  return FABRICS[acceleratorId] ?? FABRICS.h100!;
}

/**
 * The straggler incident in effect at the timeline's step, with the rank it names resolved
 * against the configured world size and its depth (the share of throughput the rank loses),
 * or undefined when the timeline has none.
 */
export function stragglerAt(
  timeline: TelemetryTimeline,
  config: Pick<RunConfig, "nodes" | "gpusPerNode">,
):
  | { readonly incident: Incident; readonly rank: number; readonly depth: number }
  | undefined {
  const world = Math.max(1, Math.floor(config.nodes) * Math.floor(config.gpusPerNode));
  const at = Math.floor(timeline.step);
  const incident = activeIncidents(timeline.stage, at).find(
    (item) => item.kind === "straggler",
  );
  if (!incident) return undefined;
  // The magnitude is the step-time excess the console charts; the lagging rank's share of
  // work done per second falls by the same proportion.
  const excess = incident.magnitude * envelope(incident, at);
  return { incident, rank: rankOf(incident, world), depth: excess / (1 + excess) };
}

/**
 * Where a thermal hot spot sits: it persists for a few minutes, then moves on or clears,
 * rather than flickering between scrapes. Thermal state is not a training incident, so it is
 * not on the run timeline.
 */
function hotSpot(
  config: RunConfig,
  now: number,
): { node: number; gpu: number; excess: number } | undefined {
  const nodes = Math.max(1, config.nodes);
  const gpus = Math.max(1, config.gpusPerNode);
  const hotWindow = Math.floor(now / 420_000);
  const hotSeed = `${config.accelerator}:${nodes}x${gpus}:${hotWindow}`;
  if (unit(`hot?:${hotSeed}`) >= 0.45) return undefined;
  return {
    node: Math.floor(unit(`hot-node:${hotSeed}`) * nodes),
    gpu: Math.floor(unit(`hot-gpu:${hotSeed}`) * gpus),
    excess: 5 + 3 * unit(`hot-excess:${hotSeed}`),
  };
}

/**
 * Telemetry for every GPU in the configured cluster, plus cluster aggregates.
 *
 * `stepsPerSecond` is the run's optimiser step rate (the effective stage's); `profile` supplies
 * the samples/s, tokens per sample and per-GPU memory the planning estimate predicts.
 * `timeline` places the run on its incident timeline; a straggler comes from there only.
 */
export function gpuTelemetry(
  profile: RunProfile,
  config: RunConfig,
  stepsPerSecond: number,
  running: boolean,
  now: number,
  timeline?: TelemetryTimeline,
): ClusterTelemetry {
  const bucket = Math.floor(now / TELEMETRY_BUCKET_MS);
  const nodeCount = Math.max(1, Math.floor(config.nodes));
  const gpusPerNode = Math.max(1, Math.floor(config.gpusPerNode));
  const accelerator = profile.accelerator;
  const tdp = ACCELERATOR_TDP_W[accelerator.id] ?? 700;
  const memTotalGb = accelerator.memoryGb;
  const hot = running ? hotSpot(config, now) : undefined;
  const lagging = running && timeline ? stragglerAt(timeline, config) : undefined;

  const nodes: NodeTelemetry[] = [];
  let allSamples: GpuSample[] = [];
  for (let n = 0; n < nodeCount; n += 1) {
    const gpus: GpuSample[] = [];
    for (let g = 0; g < gpusPerNode; g += 1) {
      const key = `${n}:${g}:${bucket}`;
      const rank = n * gpusPerNode + g;
      const isStraggler = lagging !== undefined && lagging.rank === rank;
      const isHot = hot !== undefined && hot.node === n && hot.gpu === g;

      const utilPct = running
        ? clamp(
            (isStraggler ? 94 * (1 - lagging.depth) : 94) + 3 * noise(`util:${key}`),
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
          ? clamp(76 + hot.excess + noise(`temp:${key}`), HOT_TEMP_C, 86)
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
        rank,
        utilPct: round1(utilPct),
        memUsedGb: round1(memUsedGb),
        memTotalGb,
        tempC: Math.round(tempC),
        powerW: Math.round(powerW),
        straggler: isStraggler,
        hot: isHot,
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
    ? 1 + 0.03 * noise(`cluster:${bucket}`) - (lagging ? 0.015 : 0)
    : 0;
  const samplesPerSecond = profile.samplesPerSecond * wobble;
  const liveSteps = stepsPerSecond * wobble;

  const fabric = fabricOf(accelerator.id);
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
    stragglerIncident: lagging?.incident,
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
