/**
 * Live views of a stage's inputs: ingestion pipelines, objective weighting, the instruction
 * mixture and deployment measurements.
 *
 * Two kinds of number meet here and are never mixed up. Corpus counts come from `CorpusFacts`
 * through `availability` and are real: nothing in this module raises them. Everything that
 * moves — sync schedules, samples consumed this epoch, batch composition, measured latency —
 * belongs to the simulated run and is labelled as such where it is shown.
 *
 * Every function is a pure function of its arguments. Noise comes from `hashString` over a
 * stable key, never from `Math.random`, so two viewers agree and a paused run stays frozen.
 * Sync times are the one thing that keeps moving while training is paused, because a data
 * pipeline does not stop when the optimiser does.
 */

import { hashString } from "@/lib/canvas/engineering";

import { evalLagSteps, lastEvalStep, measured } from "./evaluation";
import { curveAt } from "./run";
import { availability, type CorpusFacts } from "./samples";
import type { CurveSpec, Stage } from "./stages";

/** A uniform value in [0, 1) for a key. */
function unit(key: string): number {
  return hashString(key) / 4294967296;
}

/** The saturating approach metrics take over a run, normalised to 0 at 0 and 1 at 1. */
function ease(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const shape = Math.pow(1 + (p * 100) / 18, -1.1);
  const floor = Math.pow(1 + 100 / 18, -1.1);
  return (1 - shape) / (1 - floor);
}

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Ingestion
// ────────────────────────────────────────────────────────────────────────────────────────────

export type PipelineStatus = "Synced" | "Indexing" | "Awaiting source" | "Not connected";
export type Freshness = "fresh" | "stale" | "static";
export type SourceKind = "drawings" | "graphs" | "images" | "3d" | "telemetry" | "docs";

const MINUTE = 60;
const HOUR = 3600;

/** How often each kind of source is re-synced, seconds. */
export const SYNC_INTERVAL: Record<SourceKind, number> = {
  drawings: 6 * HOUR,
  graphs: 6 * HOUR,
  images: 30 * MINUTE,
  "3d": 24 * HOUR,
  telemetry: MINUTE,
  docs: HOUR,
};

/**
 * Which real source feeds each contract row. `null` means the corpus has no source of that
 * kind at all, so the row can never be connected, whatever its count.
 */
const ROW_SOURCE: Record<string, SourceKind | null> = {
  // Stage 1
  pid: "drawings",
  graph: "graphs",
  images: "images",
  "3d": "3d",
  ts: "telemetry",
  docs: "docs",
  // Stage 2
  packages: "docs",
  alignment: "images",
  procedural: "docs",
  topology: "graphs",
  anomaly: "telemetry",
  telemetry: "telemetry",
  // Stage 4
  traces: "docs",
  rollouts: "docs",
  correspondences: "images",
  simulation: "telemetry",
  extraction: "docs",
  dialogues: null,
};

export interface IngestionRow {
  readonly id: string;
  readonly source: SourceKind | null;
  readonly status: PipelineStatus;
  /** Real count the corpus supplies today; never inflated. */
  readonly available: number;
  /** Sync cadence, seconds; null for rows with no source. */
  readonly intervalSeconds: number | null;
  /** Epoch ms of the last completed sync; null for fixtures and unconnected rows. */
  readonly lastSyncAt: number | null;
  readonly secondsSinceSync: number | null;
  /** Human label, e.g. "Synced · 4m ago" or "Bundled fixture". */
  readonly syncLabel: string;
  readonly freshness: Freshness;
  /** Samples of this row consumed so far in the current epoch, ≤ available. */
  readonly consumed: number;
  /** Share of the current epoch completed, 0–1. */
  readonly epochShare: number;
  /** 1-based epoch the run is in over the planned dataset. */
  readonly epoch: number;
}

function formatAgoShort(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours ? `${days}d ${hours}h ago` : `${days}d ago`;
}

/**
 * Where the run is in its current pass over the planned dataset (the contract's summed
 * targets). The planned size, not today's availability, is the denominator: the corpus is
 * a subset of the plan, and each row is consumed in proportion as the epoch advances.
 */
export function epochPosition(
  stage: Stage,
  step: number,
  globalBatch: number,
): { readonly share: number; readonly epoch: number; readonly datasetSize: number } {
  const datasetSize = stage.contract.reduce((sum, row) => sum + row.target, 0);
  if (datasetSize <= 0) return { share: 0, epoch: 1, datasetSize: 0 };
  const seen = Math.max(0, Math.floor(step)) * Math.max(0, Math.floor(globalBatch));
  return {
    share: (seen % datasetSize) / datasetSize,
    epoch: Math.floor(seen / datasetSize) + 1,
    datasetSize,
  };
}

/**
 * The ingestion state of every contract row of a stage, keyed by row id.
 *
 * Syncs happen on each source's schedule, offset per row so they do not all land together.
 * A scheduled sync occasionally does not complete (decided by hash, about one in eight for
 * slow sources); the row then still shows the previous sync and goes stale until the next.
 * A sync is followed by a short indexing window.
 */
export function ingestionFor(
  stage: Stage,
  facts: CorpusFacts,
  step: number,
  globalBatch: number,
  now: number,
): ReadonlyMap<string, IngestionRow> {
  const available = availability(stage.id, facts);
  const position = epochPosition(stage, step, globalBatch);
  const rows = new Map<string, IngestionRow>();

  for (const row of stage.contract) {
    const count = Math.max(0, available.get(row.id)?.count ?? 0);
    const source = ROW_SOURCE[row.id] ?? null;
    const base = {
      id: row.id,
      source,
      available: count,
      epochShare: position.share,
      epoch: position.epoch,
    };

    if (source === null || count === 0) {
      rows.set(row.id, {
        ...base,
        status: "Not connected",
        intervalSeconds: null,
        lastSyncAt: null,
        secondsSinceSync: null,
        syncLabel: source === null ? "No source in corpus" : "Source has no records",
        freshness: "static",
        consumed: 0,
      });
      continue;
    }

    const consumed = Math.min(count, Math.floor(position.share * count));
    const interval = SYNC_INTERVAL[source];
    const catalogueOffline =
      (source === "drawings" || source === "graphs") && facts.drawings === null;

    if (facts.source === "demo" || catalogueOffline) {
      // Offline: the rows are counted from the fixture shipped with the app. Nothing syncs.
      rows.set(row.id, {
        ...base,
        status: catalogueOffline ? "Awaiting source" : "Synced",
        intervalSeconds: interval,
        lastSyncAt: null,
        secondsSinceSync: null,
        syncLabel: catalogueOffline
          ? "Bundled fixture · catalogue offline"
          : "Bundled fixture",
        freshness: "static",
        consumed,
      });
      continue;
    }

    const intervalMs = interval * 1000;
    const offset = hashString(`sync-offset:${stage.id}:${row.id}`) % intervalMs;
    const bucket = Math.floor((now - offset) / intervalMs);
    // Fast sources retry within the minute; only slower ones visibly miss a cycle.
    const missRate = interval >= HOUR ? 0.12 : interval >= 30 * MINUTE ? 0.06 : 0;
    const missed = unit(`sync-miss:${stage.id}:${row.id}:${bucket}`) < missRate;
    const lastSyncAt = (missed ? bucket - 1 : bucket) * intervalMs + offset;
    const secondsSinceSync = Math.max(0, (now - lastSyncAt) / 1000);
    const indexingWindow = Math.min(10 * MINUTE, Math.max(5, interval * 0.06));
    const indexing = !missed && secondsSinceSync < indexingWindow;
    const stale = secondsSinceSync > interval;

    rows.set(row.id, {
      ...base,
      status: indexing ? "Indexing" : "Synced",
      intervalSeconds: interval,
      lastSyncAt,
      secondsSinceSync,
      syncLabel: indexing
        ? `Indexing · started ${formatAgoShort(secondsSinceSync)}`
        : `Synced · ${formatAgoShort(secondsSinceSync)}`,
      freshness: stale ? "stale" : "fresh",
      consumed,
    });
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Alignment matrix detail
// ────────────────────────────────────────────────────────────────────────────────────────────

/** What links two modalities (indices into MODALITIES) and what the count is a count of. */
export function alignmentLink(
  row: number,
  column: number,
): { readonly what: string; readonly basis: string } {
  const a = Math.min(row, column);
  const b = Math.max(row, column);
  const links: Record<string, { what: string; basis: string }> = {
    "0-1": {
      what: "Every drawn symbol is a node in the paired GraphML topology.",
      basis: "Nodes on the loaded sheet",
    },
    "0-2": {
      what: "Field photographs registered to the symbol they depict.",
      basis: "Registered field references",
    },
    "0-3": {
      what: "Symbols whose device class has a procedural 3D model.",
      basis: "Distinct field classes with a model, plus the exchanger twin",
    },
    "0-4": {
      what: "Instrument symbols that carry a historian tag.",
      basis: "Simulated historian tags on this sheet",
    },
    "0-5": {
      what: "Documents filed against a drawn asset in the register.",
      basis: "Register documents",
    },
    "1-2": {
      what: "Photographed devices located on a topology node.",
      basis: "Registered field references",
    },
    "1-3": {
      what: "Twin component detections attached to the exchanger's graph node.",
      basis: "Detections in the exchanger twin scene",
    },
    "1-4": {
      what: "Control loops joining measured tags through the topology.",
      basis: "Control loops in the register",
    },
    "1-5": {
      what: "Work orders raised against assets in the graph.",
      basis: "Work orders in the register",
    },
    "2-3": {
      what: "Photograph detections matched to twin components.",
      basis: "Detections in the exchanger twin scene",
    },
    "2-4": {
      what: "No photograph is time-stamped against a trend window in this corpus.",
      basis: "No direct alignment",
    },
    "2-5": {
      what: "No photograph is cited by a document in this corpus.",
      basis: "No direct alignment",
    },
    "3-4": {
      what: "The exchanger twin is driven by its live telemetry.",
      basis: "One twin scene bound to telemetry",
    },
    "3-5": {
      what: "No 3D model is referenced by a document in this corpus.",
      basis: "No direct alignment",
    },
    "4-5": {
      what: "Work orders on assets whose tags have telemetry.",
      basis: "Work orders in the register, when tagged assets exist",
    },
  };
  return links[`${a}-${b}`] ?? { what: "Same modality.", basis: "Not applicable" };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Objectives
// ────────────────────────────────────────────────────────────────────────────────────────────

interface ObjectiveSpec {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
}

const OBJECTIVES: Partial<Record<Stage["id"], readonly ObjectiveSpec[]>> = {
  pretraining: [
    { key: "mlm", label: "Next-token prediction (interleaved image–text)", weight: 0.35 },
    { key: "contrastive", label: "Contrastive alignment", weight: 0.25 },
    { key: "grounding", label: "OCR / tag grounding", weight: 0.2 },
    { key: "topology", label: "Topology prediction", weight: 0.15 },
    { key: "registration", label: "2D ↔ 3D registration consistency", weight: 0.05 },
  ],
  sft: [
    { key: "language", label: "Grounded dialogue tuning", weight: 0.4 },
    { key: "grounding", label: "Spatial disambiguation / grounding", weight: 0.25 },
    { key: "tool", label: "Tool calling", weight: 0.2 },
    { key: "extraction", label: "Structured extraction", weight: 0.15 },
  ],
};

/**
 * Objectives whose loss is not plotted in the stage's loss tab. The registration term is
 * logged separately in practice; it follows the same shape as its sibling losses.
 */
const FALLBACK_CURVES: Record<string, CurveSpec> = {
  registration: {
    key: "registration-loss",
    label: "Registration loss",
    start: 1.8,
    end: 0.0055,
    tau: 1200,
    noise: 0.07,
  },
};

export interface ObjectiveShare {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly loss: number;
  /** weight × loss / Σ(weight × loss); shares sum to 1. */
  readonly share: number;
  /** True when the loss is not one of the plotted curves. */
  readonly derived: boolean;
}

export function objectiveShares(stage: Stage, step: number): readonly ObjectiveShare[] {
  const specs = OBJECTIVES[stage.id];
  const tab = stage.curves[0];
  if (!specs || !tab) return [];
  const rows = specs.map((spec) => {
    const plotted = tab.curves.find((curve) => curve.key === spec.key);
    const curve = plotted ?? FALLBACK_CURVES[spec.key];
    const loss = curve ? Math.max(0, curveAt(curve, step, stage)) : 0;
    return {
      key: spec.key,
      label: spec.label,
      weight: spec.weight,
      loss,
      derived: !plotted,
    };
  });
  const total = rows.reduce((sum, row) => sum + row.weight * row.loss, 0);
  return rows.map((row) => ({
    ...row,
    share: total > 0 ? (row.weight * row.loss) / total : row.weight,
  }));
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Instruction mixture
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The planned task families, in the order the donut and its legend draw them. Series are
 * taken in that order, so a family's colour is its position here and no colour is stored.
 */
export const MIXTURE_FAMILIES = [
  { id: "qa", label: "Plant QA", share: 0.25 },
  { id: "grounding", label: "Grounding", share: 0.2 },
  { id: "topology", label: "Topology / tool-use", share: 0.2 },
  { id: "procedure", label: "Procedure reasoning", share: 0.2 },
  { id: "telemetry", label: "Telemetry-conditioned", share: 0.15 },
] as const;

export interface MixtureFamilyCount {
  readonly id: string;
  readonly label: string;
  readonly share: number;
  /** Samples of this family seen since step 0. */
  readonly seen: number;
  /** Samples of this family in the most recent optimiser batch. */
  readonly lastBatch: number;
}

export interface MixtureCounts {
  /** Index of the most recent completed batch (the integer step). */
  readonly batchIndex: number;
  readonly batchSize: number;
  readonly totalSeen: number;
  readonly families: readonly MixtureFamilyCount[];
  /** The tick the reading was taken at. */
  readonly asOf: number;
}

/** Round non-negative weights to integers summing to `total` (largest remainder). */
function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((acc, n) => acc + n, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((x, y) => y.frac - x.frac || x.index - y.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index]! += 1;
    remainder -= 1;
  }
  return floors;
}

/**
 * Samples seen per task family, and the make-up of the latest batch. The batch is drawn
 * like a multinomial sample: each family's count scatters around its expected share with a
 * binomial-sized spread (a hash-seeded normal draw), then counts are rounded to sum exactly
 * to the global batch.
 */
export function mixtureCounts(
  step: number,
  globalBatch: number,
  now: number,
): MixtureCounts {
  const batchSize = Math.max(0, Math.floor(globalBatch));
  const batchIndex = Math.max(0, Math.floor(step));
  const totalSeen = batchIndex * batchSize;
  const seen = apportion(
    MIXTURE_FAMILIES.map((family) => family.share),
    totalSeen,
  );
  const draws = MIXTURE_FAMILIES.map((family) => {
    const mean = batchSize * family.share;
    const sd = Math.sqrt(batchSize * family.share * (1 - family.share));
    const u1 = Math.max(1e-9, unit(`mix:${batchIndex}:${family.id}:a`));
    const u2 = unit(`mix:${batchIndex}:${family.id}:b`);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, mean + sd * Math.max(-2.5, Math.min(2.5, z)));
  });
  // A draw where every family clamps to zero falls back to the planned shares.
  const drawn = draws.some((value) => value > 0)
    ? draws
    : MIXTURE_FAMILIES.map((family) => family.share);
  const lastBatch = apportion(drawn, batchSize);
  return {
    batchIndex,
    batchSize,
    totalSeen,
    families: MIXTURE_FAMILIES.map((family, index) => ({
      id: family.id,
      label: family.label,
      share: family.share,
      seen: seen[index]!,
      lastBatch: lastBatch[index]!,
    })),
    asOf: now,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Reward contract (stage 3)
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface BatchReward {
  readonly name: string;
  readonly weight: number;
  /** Mean verifier score over the batch, 0–1 (penalty: rate of penalised answers). */
  readonly score: number;
  /** weight × score. */
  readonly value: number;
}

function stageCurve(stage: Stage, key: string): CurveSpec | undefined {
  return stage.curves.flatMap((tab) => tab.curves).find((curve) => curve.key === key);
}

/**
 * Weighted reward per contract row for the current batch of the simulated policy.
 *
 * The rows are one decomposition of the batch mean reward the curves plot, not a second
 * estimate of it: the penalty row is the weight times the batch hallucination rate, and the
 * positive rows share out the rest, each with its own fixed offset and per-batch jitter, so
 * the column sums to the mean reward at this step.
 */
export function batchRewards(
  stage: Stage,
  step: number,
  progress: number,
): readonly BatchReward[] {
  const rewards = stage.rewards ?? [];
  const at = Math.max(0, step);
  const bucket = Math.floor(at / 40);
  const t = ease(progress);
  const meanCurve = stageCurve(stage, "reward");
  const rateCurve = stageCurve(stage, "halluc");
  const hallucination = Math.min(
    1,
    Math.max(0, rateCurve ? curveAt(rateCurve, at, stage) : lerp(0.15, 0.035, t)),
  );

  const raw = rewards.map((reward) => {
    if (reward.weight < 0) return hallucination;
    const jitter = (unit(`reward:${reward.name}:${bucket}`) * 2 - 1) * 0.03;
    const offset = (unit(`reward-offset:${reward.name}`) * 2 - 1) * 0.05;
    return offset + jitter;
  });
  const positiveWeight =
    rewards.reduce((sum, reward) => sum + Math.max(0, reward.weight), 0) || 1;
  let penalty = 0;
  let spread = 0;
  rewards.forEach((reward, index) => {
    if (reward.weight < 0) penalty += reward.weight * raw[index]!;
    else spread += reward.weight * raw[index]!;
  });
  const mean = meanCurve ? curveAt(meanCurve, at, stage) : lerp(0.18, 0.71, t);
  // The common level of the positive scores that makes the weighted rows sum to `mean`.
  const level = (mean - penalty - spread) / positiveWeight;

  return rewards.map((reward, index) => {
    const score =
      reward.weight < 0 ? raw[index]! : Math.min(1, Math.max(0, level + raw[index]!));
    return {
      name: reward.name,
      weight: reward.weight,
      score,
      value: reward.weight * score,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Deployment (stage 4)
// ────────────────────────────────────────────────────────────────────────────────────────────

export type DeploymentStatus = "Supported" | "Ready" | "Pending";

export interface DeploymentTarget {
  readonly id: "vllm" | "tensorrt" | "edge" | "local";
  readonly name: string;
  readonly detail: string;
  readonly status: DeploymentStatus;
  /** What has to happen before the status changes, when pending. */
  readonly gate: string;
  readonly p50: number;
  readonly p95: number;
  readonly tokensPerSecond: number;
  readonly memoryGb: number;
}

export interface DeploymentMeasurements {
  /** Step whose published evaluation produced these numbers (0 = baseline). */
  readonly evalStep: number;
  /** Share of the run at which the measurement was taken. */
  readonly measuredProgress: number;
  /** Epoch ms the measurement was published. */
  readonly measuredAt: number;
  readonly targets: readonly DeploymentTarget[];
}

/** A served export's measurement model; the local profile is derived instead (see below). */
interface TargetModel {
  readonly id: Exclude<DeploymentTarget["id"], "local">;
  readonly name: string;
  readonly detail: string;
  readonly p50: readonly [number, number];
  readonly tail: readonly [number, number];
  readonly tokens: readonly [number, number];
  readonly memory: readonly [number, number];
  readonly supportedAt: number;
  readonly memoryBudgetGb?: number;
}

/**
 * The local profile's request: a 4K-token prompt answered with 256 tokens on one H100 80GB
 * at batch 1, the same setup as the stage-4 serving metrics. It is Ready once its p95
 * end-to-end latency is under this target.
 */
export const LOCAL_ANSWER_TOKENS = 256;
export const LOCAL_P95_TARGET_S = 2.5;

const TARGET_MODELS: readonly TargetModel[] = [
  {
    id: "vllm",
    name: "vLLM server",
    detail: "BF16 / INT8 W8A16, continuous batching",
    p50: [0.62, 0.38],
    tail: [1.9, 1.55],
    tokens: [142, 196],
    memory: [12.8, 10.6],
    supportedAt: 0.1,
  },
  {
    id: "tensorrt",
    name: "TensorRT-LLM",
    detail: "INT8 W8A16 · FP8 KV cache, fused kernels",
    p50: [0.55, 0.29],
    tail: [1.7, 1.4],
    tokens: [165, 238],
    memory: [11.9, 9.7],
    supportedAt: 0.3,
  },
  {
    id: "edge",
    name: "Edge GPU / plant server",
    detail: "L4 / L40S, 24 GB budget (L4), air-gapped",
    p50: [1.05, 0.62],
    tail: [1.8, 1.45],
    tokens: [31, 46],
    memory: [17.6, 14.2],
    supportedAt: 0.5,
    memoryBudgetGb: 24,
  },
];

/**
 * Latency, throughput and memory per deployment target from the quantisation-aware pass of
 * the stage's evaluation harness. The numbers change only when an evaluation publishes, at
 * the step the metrics table reports. The other targets scale from the same progress with a
 * small, fixed measurement scatter.
 *
 * The local profile is derived from the metrics table's serving rows, measured on the same
 * H100 at batch 1 with a 4K prompt. End-to-end latency for an N-token answer is time to first
 * token plus N decode steps:
 *   p95 ≈ TTFT p50 + N × TPOT p95     (every decode step at its p95: a conservative tail)
 *   p50 ≈ TTFT p50 + N / decode tok/s (mean decode step)
 * It is Ready exactly when that p95 is under LOCAL_P95_TARGET_S.
 */
export function deploymentMeasurements(
  stage: Stage,
  step: number,
  now: number,
): DeploymentMeasurements {
  const { run } = stage;
  const evalStep = lastEvalStep(stage, step);
  const measuredProgress = Math.min(1, evalStep / Math.max(1, run.totalSteps));
  const t = ease(measuredProgress);
  const fromMetric = (prefix: string): number | undefined => {
    const spec = stage.metrics.find((m) => m.label.startsWith(prefix));
    return spec ? measured(spec, stage, evalStep) : undefined;
  };

  const served = TARGET_MODELS.map((model): DeploymentTarget => {
    const scatter = (key: string, size: number) =>
      1 + (unit(`deploy:${model.id}:${key}:${evalStep}`) * 2 - 1) * size;
    const p50 = lerp(model.p50[0], model.p50[1], t) * scatter("p50", 0.02);
    const p95 = p50 * lerp(model.tail[0], model.tail[1], t) * scatter("p95", 0.015);
    const memoryGb = lerp(model.memory[0], model.memory[1], t) * scatter("mem", 0.005);
    const reached = measuredProgress >= model.supportedAt;
    const fits = model.memoryBudgetGb === undefined || memoryGb <= model.memoryBudgetGb;
    const status: DeploymentStatus = reached && fits ? "Supported" : "Pending";
    return {
      id: model.id,
      name: model.name,
      detail: model.detail,
      status,
      gate:
        status === "Supported"
          ? "Export validated"
          : !reached
            ? `Export validated at ${Math.round(model.supportedAt * 100)}%`
            : `Needs ≤ ${model.memoryBudgetGb} GB`,
      p50,
      p95,
      tokensPerSecond: lerp(model.tokens[0], model.tokens[1], t) * scatter("tok", 0.02),
      memoryGb,
    };
  });

  // The local profile, from the metrics table's serving rows (milliseconds → seconds).
  const ttftS = (fromMetric("Time to first token p50") ?? 0) / 1000;
  const tpotP95S = (fromMetric("Time per output token p95") ?? 0) / 1000;
  const decodeTokS = fromMetric("Decode throughput") ?? 0;
  const p95 = ttftS + LOCAL_ANSWER_TOKENS * tpotP95S;
  const ready = p95 < LOCAL_P95_TARGET_S;
  const answer = `${LOCAL_ANSWER_TOKENS}-token answer`;
  const local: DeploymentTarget = {
    id: "local",
    name: "Local inference profile",
    detail: `H100 80GB · batch 1 · 4K prompt + ${answer}`,
    status: ready ? "Ready" : "Pending",
    gate: ready
      ? `p95 under ${LOCAL_P95_TARGET_S} s (${answer})`
      : `p95 ${p95.toFixed(2)} s, needs < ${LOCAL_P95_TARGET_S} s (${answer})`,
    p50: ttftS + (decodeTokS > 0 ? LOCAL_ANSWER_TOKENS / decodeTokS : 0),
    p95,
    tokensPerSecond: decodeTokS,
    memoryGb: fromMetric("Serving memory") ?? 0,
  };
  const targets = [...served, local];

  const rate = run.stepsPerSecond > 0 ? run.stepsPerSecond : 1;
  const lag = evalStep === 0 || evalStep >= run.totalSteps ? 0 : evalLagSteps(stage);
  return {
    evalStep,
    measuredProgress,
    measuredAt: now - (Math.max(0, step - evalStep - lag) / rate) * 1000,
    targets,
  };
}
