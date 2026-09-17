/**
 * The event log of the simulated training run.
 *
 * A real run's log is a by-product of its step timeline: a checkpoint is written every
 * `checkpointEvery` steps and uploaded a few minutes later, an evaluation finishes some
 * minutes after the step it evaluates, the learning-rate schedule changes phase at fixed
 * steps, and now and then a node times out or the loss spikes and settles again. This module
 * derives that log from (stage, step) alone. Where an event takes wall-clock time — writing a
 * checkpoint, running an evaluation — the delay is stated in seconds and converted to steps
 * with the run's throughput, so a slow configuration spreads the same five-minute upload over
 * fewer steps rather than stretching it to hours.
 *
 * Irregular events (warnings, recoveries) are placed by hashing the experiment and a step
 * bucket, never by `Math.random`, so every viewer sees the same log and a paused run's log is
 * frozen: the same step always yields the same events.
 */

import { hashString, seededRandom } from "@/lib/canvas/engineering";

import { EVAL_SECONDS, evalEvery, measured } from "./evaluation";
import { checkpoints, curveAt, isBetter, learningRateAt } from "./run";
import type { Stage } from "./stages";

// One evaluation schedule for the whole page: the log, the metrics table and the checkpoint
// table all read it from the evaluation harness.
export { EVAL_SECONDS, evalEvery };

export type EventSeverity = "info" | "warn" | "ok";

export type EventKind =
  | "run-started"
  | "run-complete"
  | "checkpoint-written"
  | "checkpoint-verified"
  | "eval"
  | "lr-phase"
  | "loss-spike"
  | "loss-recovered"
  | "grad-clip"
  | "nccl-retry"
  | "loader-stall"
  | "shard-rollover";

export type EventFilter = "all" | "warnings" | "checkpoints" | "evals";

export interface RunEvent {
  readonly id: string;
  /** The (possibly fractional) global step the event happened at. */
  readonly step: number;
  /** Seconds of training between the event and the current step. Frozen while paused. */
  readonly ageSeconds: number;
  /** Epoch ms the event happened at, relative to `now`. */
  readonly atEpoch: number;
  readonly severity: EventSeverity;
  readonly kind: EventKind;
  readonly message: string;
}

export interface EventOptions {
  readonly filter?: EventFilter;
  /** Nodes in the job, for naming the node a collective timed out on. */
  readonly nodes?: number;
  readonly gpusPerNode?: number;
}

/** Wall-clock seconds from the checkpoint step boundary to the end of each write phase. */
export const SERIALIZE_SECONDS = 75;
export const UPLOAD_SECONDS = 240;
export const WRITE_WINDOW_SECONDS = 300;

const KIND_ORDER: readonly EventKind[] = [
  "run-complete",
  "checkpoint-verified",
  "eval",
  "checkpoint-written",
  "loss-recovered",
  "loss-spike",
  "grad-clip",
  "nccl-retry",
  "loader-stall",
  "shard-rollover",
  "lr-phase",
  "run-started",
];

const number = (value: number) => Math.round(value).toLocaleString("en-US");

/** Deterministic value in [0, 1) for a key. */
function unit(key: string): number {
  return hashString(key) / 4294967296;
}

function safeRate(stepsPerSecond: number): number {
  return Number.isFinite(stepsPerSecond) && stepsPerSecond > 0 ? stepsPerSecond : 1e-6;
}

export function checkpointName(step: number): string {
  return `step-${String(Math.round(step)).padStart(6, "0")}`;
}

export function checkpointUri(stage: Stage, step: number): string {
  return `s3://pid-lab/${stage.experimentId}/${checkpointName(step)}/`;
}

/** A sha256-shaped digest: 64 hex characters, derived from the run. Not a real hash. */
export function checkpointDigest(stage: Stage, step: number): string {
  const random = seededRandom(
    hashString(`${stage.experimentId}:${stage.id}:${Math.round(step)}`),
  );
  let digest = "";
  for (let index = 0; index < 8; index += 1) {
    digest += Math.floor(random() * 4294967296)
      .toString(16)
      .padStart(8, "0");
  }
  return digest;
}

/** Shards a checkpoint of the stage's size is written in: about one per 8 GB, at least 4. */
export function checkpointShards(stage: Stage): number {
  const match = /([\d.]+)\s*(GB|TB|MB)/i.exec(stage.run.checkpointSize);
  const value = match ? Number(match[1]) : 8;
  const unitName = match?.[2]?.toUpperCase() ?? "GB";
  const gb = unitName === "TB" ? value * 1024 : unitName === "MB" ? value / 1024 : value;
  return Math.min(32, Math.max(4, Math.ceil(gb / 8)));
}

/**
 * Score of the stage's primary metric for an evaluation at a step: exactly the number the
 * metrics table shows once that evaluation has published.
 */
export function evalScoreAt(stage: Stage, step: number): number {
  return measured(stage.metrics[0]!, stage, Math.round(step));
}

function shardEvery(stage: Stage): number {
  return Math.max(1, Math.round(stage.run.checkpointEvery * 0.6));
}

interface Draft {
  readonly id: string;
  readonly step: number;
  readonly severity: EventSeverity;
  readonly kind: EventKind;
  readonly message: string;
}

function spikeCurve(stage: Stage) {
  if (stage.id === "rl") {
    const kl = stage.curves
      .flatMap((tab) => tab.curves)
      .find((curve) => curve.key === "kl");
    return { curve: kl ?? stage.curves[0]!.curves[0]!, label: "KL" };
  }
  if (stage.id === "distillation") {
    return { curve: stage.curves[0]!.curves[0]!, label: "Distillation KL" };
  }
  return { curve: stage.curves[0]!.curves[0]!, label: "Loss" };
}

/** Every event whose originating boundary could place it inside [lo, hi]. */
function draftsBetween(
  stage: Stage,
  lo: number,
  hi: number,
  rate: number,
  options: EventOptions,
): Draft[] {
  const { run } = stage;
  const drafts: Draft[] = [];
  const seed = `${stage.id}:${stage.experimentId}`;
  const metric = stage.metrics[0]!;
  const every = run.checkpointEvery;

  // Start of run and learning-rate phases.
  if (lo <= 0) {
    drafts.push({
      id: "run-started",
      step: 0,
      severity: "info",
      kind: "run-started",
      message: `Run started · linear warmup over ${number(run.warmupSteps)} steps`,
    });
  }
  if (run.warmupSteps > 0) {
    drafts.push({
      id: "lr-warmup",
      step: run.warmupSteps,
      severity: "info",
      kind: "lr-phase",
      message: `Warmup complete · peak LR ${run.learningRate.toExponential(1)}, cosine decay begins`,
    });
  }
  const midpoint = run.warmupSteps + (run.totalSteps - run.warmupSteps) / 2;
  drafts.push({
    id: "lr-midpoint",
    step: midpoint,
    severity: "info",
    kind: "lr-phase",
    message: `Cosine schedule past midpoint · LR ${learningRateAt(run, midpoint).toExponential(1)}`,
  });
  drafts.push({
    id: "run-complete",
    step: run.totalSteps,
    severity: "ok",
    kind: "run-complete",
    message: `Run complete · final checkpoint ${checkpointName(run.totalSteps)}`,
  });

  // Checkpoints: written at the boundary, verified once the upload finishes.
  const valLoss = new Map(
    checkpoints(stage, hi + every, Number.MAX_SAFE_INTEGER).map((item) => [
      item.step,
      item.valLoss,
    ]),
  );
  const verifyLag = WRITE_WINDOW_SECONDS * rate;
  const serializeLag = SERIALIZE_SECONDS * rate;
  const shards = checkpointShards(stage);
  for (
    let at = Math.max(every, Math.floor((lo - verifyLag) / every) * every);
    at <= Math.min(hi, run.totalSteps);
    at += every
  ) {
    const loss = valLoss.get(at);
    // Logged when serialisation finishes; the checkpoint table shows it uploading until verified.
    drafts.push({
      id: `ckpt-write:${at}`,
      step: at + serializeLag,
      severity: "info",
      kind: "checkpoint-written",
      message: `Checkpoint ${checkpointName(at)} serialized · ${run.checkpointSize} in ${shards} shards, uploading${
        loss === undefined
          ? ""
          : ` · ${stage.id === "rl" ? "reward" : stage.id === "distillation" ? "val KL" : "val loss"} ${loss.toFixed(3)}`
      }`,
    });
    drafts.push({
      id: `ckpt-verify:${at}`,
      step: at + verifyLag,
      severity: "ok",
      kind: "checkpoint-verified",
      message: `Upload verified · ${checkpointName(at)} · sha256 ${checkpointDigest(stage, at).slice(0, 12)}… (simulated)`,
    });
  }

  // Evaluations finish some minutes after the step they evaluate.
  const evalStep = evalEvery(stage);
  const evalLag = EVAL_SECONDS * rate;
  for (
    let at = Math.max(evalStep, Math.floor((lo - evalLag) / evalStep) * evalStep);
    at <= Math.min(hi, run.totalSteps);
    at += evalStep
  ) {
    const score = evalScoreAt(stage, at);
    drafts.push({
      id: `eval:${at}`,
      step: at + evalLag,
      severity: "ok",
      kind: "eval",
      message: `Eval ${checkpointName(at)} · ${metric.label} ${score.toFixed(metric.digits)}${
        metric.target === undefined
          ? ""
          : ` (target ${metric.target.toFixed(metric.digits)})`
      }`,
    });
  }

  // Dataset shard rollovers.
  const shard = shardEvery(stage);
  const totalShards = Math.ceil(run.totalSteps / shard);
  for (
    let at = Math.max(shard, Math.floor(lo / shard) * shard);
    at <= Math.min(hi, run.totalSteps);
    at += shard
  ) {
    const index = at / shard;
    drafts.push({
      id: `shard:${at}`,
      step: at,
      severity: "info",
      kind: "shard-rollover",
      message: `Dataset shard rollover → shard ${String(index + 1).padStart(5, "0")} of ${String(totalShards).padStart(5, "0")} (reshuffled)`,
    });
  }

  // Irregular warnings: at most one per bucket, placed by hash.
  // Faults arrive per hour of wall-clock time, so the bucket spans at least 90 minutes of steps.
  const bucket = Math.max(1, Math.round(every / 8), Math.round(5400 * rate));
  const maxRecovery = 360 * rate;
  const nodes = Math.max(1, options.nodes ?? 1);
  const gpusPerNode = Math.max(1, options.gpusPerNode ?? 8);
  const { curve: spike, label: spikeLabel } = spikeCurve(stage);
  for (
    let index = Math.max(0, Math.floor((lo - maxRecovery) / bucket) - 1);
    index * bucket <= Math.min(hi, run.totalSteps);
    index += 1
  ) {
    const key = `${seed}:warn:${index}`;
    if (unit(key) >= 0.3) continue;
    const at = index * bucket + bucket * (0.15 + 0.7 * unit(`${key}:at`));
    if (at <= run.warmupSteps / 4 || at >= run.totalSteps) continue;
    const pick = unit(`${key}:kind`);
    const a = unit(`${key}:a`);
    const b = unit(`${key}:b`);
    if (pick < 0.3) {
      const mean = curveAt(spike, at);
      const ratio = 2 + 1.5 * a;
      const recoverySteps = Math.max(1, (120 + 240 * b) * rate);
      const digits = mean < 0.1 ? 4 : 3;
      drafts.push({
        id: `spike:${index}`,
        step: at,
        severity: "warn",
        kind: "loss-spike",
        message:
          stage.id === "rl"
            ? `KL spike ${(mean * ratio).toFixed(4)} (${ratio.toFixed(1)}× rolling mean) · adaptive KL coefficient raised`
            : `${spikeLabel} spike at step ${number(at)} · ${(mean * ratio).toFixed(digits)} vs rolling mean ${mean.toFixed(digits)} (${ratio.toFixed(1)}×)`,
      });
      drafts.push({
        id: `recover:${index}`,
        step: at + recoverySteps,
        severity: "ok",
        kind: "loss-recovered",
        message: `${spikeLabel} recovered to ${curveAt(spike, at + recoverySteps).toFixed(digits)} automatically after ${number(Math.max(1, recoverySteps))} steps · no rollback`,
      });
    } else if (pick < 0.55) {
      const clipped = 12 + Math.floor(a * 40);
      drafts.push({
        id: `clip:${index}`,
        step: at,
        severity: "warn",
        kind: "grad-clip",
        message: `Gradient-norm clip burst · ${clipped} of 64 micro-batches clipped at max-norm 1.0`,
      });
    } else if (pick < 0.8) {
      const node = Math.floor(a * nodes);
      const rank = node * gpusPerNode + Math.floor(b * gpusPerNode);
      const lost = 20 + Math.floor(b * 50);
      drafts.push({
        id: `nccl:${index}`,
        step: at,
        severity: "warn",
        kind: "nccl-retry",
        message: `NCCL all-reduce timeout on node-${String(node).padStart(2, "0")} (rank ${rank}) · retried, ${lost} s lost`,
      });
    } else {
      const worker = Math.floor(a * 16);
      const waited = 15 + Math.floor(b * 45);
      drafts.push({
        id: `stall:${index}`,
        step: at,
        severity: "warn",
        kind: "loader-stall",
        message: `Data loader stall · worker ${worker} waited ${waited} s on shard read, prefetch refilled`,
      });
    }
  }

  return drafts;
}

export function matchesFilter(
  event: Pick<RunEvent, "kind" | "severity">,
  filter: EventFilter,
) {
  switch (filter) {
    case "all":
      return true;
    case "warnings":
      return event.severity === "warn";
    case "checkpoints":
      return event.kind === "checkpoint-written" || event.kind === "checkpoint-verified";
    case "evals":
      return event.kind === "eval";
  }
}

export function filterEvents(
  events: readonly RunEvent[],
  filter: EventFilter,
): readonly RunEvent[] {
  return events.filter((event) => matchesFilter(event, filter));
}

function compareEvents(a: Draft, b: Draft): number {
  if (b.step !== a.step) return b.step - a.step;
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/**
 * The newest `limit` events up to `step`, newest first. The search window widens backwards
 * until it holds enough events, so cost follows `limit`, not the length of the run.
 */
export function runEvents(
  stage: Stage,
  step: number,
  now: number,
  stepsPerSecond: number,
  limit = 8,
  options: EventOptions = {},
): readonly RunEvent[] {
  const rate = safeRate(stepsPerSecond);
  const filter = options.filter ?? "all";
  const hi = Math.max(0, Math.min(step, stage.run.totalSteps));
  let span = stage.run.checkpointEvery * 2;
  let found: Draft[] = [];
  for (;;) {
    const lo = Math.max(0, hi - span);
    found = draftsBetween(stage, lo, hi, rate, options).filter(
      (draft) => draft.step >= lo && draft.step <= hi && matchesFilter(draft, filter),
    );
    if (found.length >= limit || lo === 0) break;
    span *= 2;
  }
  const unique = new Map(found.map((draft) => [draft.id, draft]));
  return [...unique.values()]
    .sort(compareEvents)
    .slice(0, limit)
    .map((draft) => {
      const ageSeconds = Math.max(0, (step - draft.step) / rate);
      return { ...draft, ageSeconds, atEpoch: now - ageSeconds * 1000 };
    });
}

export interface UpcomingEvent {
  readonly kind: "checkpoint" | "eval" | "lr-phase";
  readonly step: number;
  readonly etaSeconds: number;
  readonly atEpoch: number;
  readonly label: string;
}

/** Scheduled items still ahead of the run, soonest first. */
export function nextEvents(
  stage: Stage,
  step: number,
  now: number,
  stepsPerSecond: number,
): readonly UpcomingEvent[] {
  const { run } = stage;
  const rate = safeRate(stepsPerSecond);
  const upcoming: Omit<UpcomingEvent, "etaSeconds" | "atEpoch">[] = [];
  if (step >= run.totalSteps) return [];

  const nextCheckpoint = Math.min(
    run.totalSteps,
    (Math.floor(step / run.checkpointEvery) + 1) * run.checkpointEvery,
  );
  upcoming.push({
    kind: "checkpoint",
    step: nextCheckpoint,
    label: `Checkpoint ${checkpointName(nextCheckpoint)}`,
  });

  const evalStep = evalEvery(stage);
  const evalLag = EVAL_SECONDS * rate;
  // The earliest evaluation whose completion is still ahead (it may already be running).
  let evalAt = Math.max(evalStep, Math.floor((step - evalLag) / evalStep) * evalStep);
  while (evalAt + evalLag <= step) evalAt += evalStep;
  if (evalAt <= run.totalSteps) {
    upcoming.push({
      kind: "eval",
      step: evalAt + evalLag,
      label:
        evalAt <= step
          ? `Eval of ${checkpointName(evalAt)} finishes`
          : `Eval at ${checkpointName(evalAt)}`,
    });
  }

  if (step < run.warmupSteps) {
    upcoming.push({ kind: "lr-phase", step: run.warmupSteps, label: "Warmup ends" });
  }

  return upcoming
    .map((item) => {
      const etaSeconds = Math.max(0, (item.step - step) / rate);
      return { ...item, etaSeconds, atEpoch: now + etaSeconds * 1000 };
    })
    .sort((a, b) => a.etaSeconds - b.etaSeconds);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Checkpoint lifecycle
// ────────────────────────────────────────────────────────────────────────────────────────────

export type WritePhase = "serialize" | "upload" | "verify";

export interface InFlightCheckpoint {
  readonly step: number;
  readonly phase: WritePhase;
  /** e.g. "Writing 3/8 shards". */
  readonly label: string;
  readonly shards: number;
  readonly shardsDone: number;
  /** 0–1 across the whole write window. */
  readonly fraction: number;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
  readonly uri: string;
}

export type CheckpointStatus = "Verified" | "Evaluated" | "Best";

export interface CheckpointRecord {
  readonly step: number;
  readonly valLoss: number;
  /** Primary-metric score, once the evaluation of this checkpoint has finished. */
  readonly evalScore: number | undefined;
  readonly status: CheckpointStatus;
  readonly best: boolean;
  readonly size: string;
  readonly shards: number;
  readonly uri: string;
  /** sha256-shaped, derived from the run; the run is simulated so there are no bytes to hash. */
  readonly digest: string;
  readonly ageSeconds: number;
  readonly writtenAt: number;
}

export interface CheckpointLifecycle {
  readonly writing: InFlightCheckpoint | undefined;
  readonly next: { readonly step: number; readonly etaSeconds: number } | undefined;
  /** Completed checkpoints, newest first. */
  readonly records: readonly CheckpointRecord[];
  readonly best: CheckpointRecord | undefined;
}

export function checkpointLifecycle(
  stage: Stage,
  step: number,
  stepsPerSecond: number,
  now: number,
): CheckpointLifecycle {
  const { run } = stage;
  const rate = safeRate(stepsPerSecond);
  const shards = checkpointShards(stage);
  const all = checkpoints(stage, step, Number.MAX_SAFE_INTEGER);

  let writing: InFlightCheckpoint | undefined;
  const completed = all.filter((item) => {
    const elapsed = (step - item.step) / rate;
    // Only the newest checkpoint can be in flight; an older one inside the window has finished.
    if (elapsed >= WRITE_WINDOW_SECONDS || writing) return true;
    const phase: WritePhase =
      elapsed < SERIALIZE_SECONDS
        ? "serialize"
        : elapsed < UPLOAD_SECONDS
          ? "upload"
          : "verify";
    const within =
      phase === "serialize"
        ? elapsed / SERIALIZE_SECONDS
        : phase === "upload"
          ? (elapsed - SERIALIZE_SECONDS) / (UPLOAD_SECONDS - SERIALIZE_SECONDS)
          : 1;
    const shardsDone = Math.min(shards, Math.floor(within * shards));
    writing = {
      step: item.step,
      phase,
      label:
        phase === "serialize"
          ? `Writing ${shardsDone}/${shards} shards`
          : phase === "upload"
            ? `Uploading ${shardsDone}/${shards} shards`
            : "Verifying digest",
      shards,
      shardsDone: phase === "verify" ? shards : shardsDone,
      fraction: Math.min(1, elapsed / WRITE_WINDOW_SECONDS),
      elapsedSeconds: elapsed,
      remainingSeconds: WRITE_WINDOW_SECONDS - elapsed,
      uri: checkpointUri(stage, item.step),
    };
    return false;
  });

  const bestStep = completed.reduce<(typeof completed)[number] | undefined>(
    (top, item) => (!top || isBetter(stage, item.valLoss, top.valLoss) ? item : top),
    undefined,
  )?.step;

  const records = completed.map((item): CheckpointRecord => {
    const ageSeconds = (step - item.step) / rate;
    const evaluated = ageSeconds >= EVAL_SECONDS;
    const best = item.step === bestStep;
    return {
      step: item.step,
      valLoss: item.valLoss,
      evalScore: evaluated ? evalScoreAt(stage, item.step) : undefined,
      status: best ? "Best" : evaluated ? "Evaluated" : "Verified",
      best,
      size: run.checkpointSize,
      shards,
      uri: checkpointUri(stage, item.step),
      digest: checkpointDigest(stage, item.step),
      ageSeconds,
      writtenAt: now - ageSeconds * 1000,
    };
  });

  const nextStep = (Math.floor(step / run.checkpointEvery) + 1) * run.checkpointEvery;
  const next =
    step < run.totalSteps
      ? {
          step: Math.min(nextStep, run.totalSteps),
          etaSeconds: (Math.min(nextStep, run.totalSteps) - step) / rate,
        }
      : undefined;

  return { writing, next, records, best: records.find((item) => item.best) };
}
