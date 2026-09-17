/**
 * A simulated training run that advances with the wall clock.
 *
 * No accelerator is attached to this application, so no model is being trained. What this
 * module provides instead is a run that behaves like one: the step count grows at the stage's
 * published throughput, losses fall and metrics climb along the saturating curves real runs
 * follow, checkpoints appear at the configured cadence, and pausing freezes all of it. Every
 * value is a pure function of (stage, run control, time), so reloading the page, opening a
 * second tab or asking a test for step 70,000 all give the same numbers.
 *
 * The page labels the run as simulated wherever it is shown.
 */

import { hashString } from "@/lib/canvas/engineering";

import type { CurveSpec, MetricSpec, RunSpec, Stage } from "./stages";

export type RunStatus = "running" | "paused";

/** Where the run was at a moment, and whether it has been moving since. */
export interface RunControl {
  readonly status: RunStatus;
  readonly step: number;
  /** Epoch milliseconds the step was recorded at. */
  readonly at: number;
}

export function openingControl(run: RunSpec, now: number): RunControl {
  return { status: "running", step: run.openingStep, at: now };
}

/** The step the run has reached at `now`. O(1). */
export function stepAt(control: RunControl, run: RunSpec, now: number): number {
  const moved =
    control.status === "running"
      ? (Math.max(0, now - control.at) / 1000) * run.stepsPerSecond
      : 0;
  return Math.min(run.totalSteps, control.step + moved);
}

export function pause(control: RunControl, run: RunSpec, now: number): RunControl {
  return { status: "paused", step: stepAt(control, run, now), at: now };
}

export function resume(control: RunControl, run: RunSpec, now: number): RunControl {
  const step = stepAt(control, run, now);
  // A finished stage starts again from zero: that is what "run training stage" means then.
  return { status: "running", step: step >= run.totalSteps ? 0 : step, at: now };
}

/** Deterministic noise in [-1, 1] for a key at a coarse step bucket, so curves do not shimmer. */
function jitter(key: string, step: number): number {
  const bucket = Math.floor(step / 250);
  return (hashString(`${key}:${bucket}`) / 4294967296) * 2 - 1;
}

/**
 * A curve's value at a step: a power-law approach from `start` to `end`, the shape both loss
 * and score curves take in practice, with multiplicative noise that shrinks as training
 * settles.
 */
export function curveAt(curve: CurveSpec, step: number): number {
  const shape = Math.pow(1 + step / curve.tau, -1.35);
  const value = curve.end + (curve.start - curve.end) * shape;
  const noise = curve.noise * (0.4 + 0.6 * shape) * jitter(curve.key, step);
  return value * (1 + noise);
}

/** Sample a curve from step 0 to `upTo` in `points` log-spaced-then-linear steps. */
export function curveSeries(
  curve: CurveSpec,
  upTo: number,
  points = 180,
): readonly { readonly step: number; readonly value: number }[] {
  const series: { step: number; value: number }[] = [];
  if (upTo <= 0) return [{ step: 0, value: curveAt(curve, 0) }];
  for (let index = 0; index < points; index += 1) {
    const step = (upTo * index) / (points - 1);
    series.push({ step, value: curveAt(curve, step) });
  }
  return series;
}

/** A metric's value at a share of the run: the same saturating approach, without noise. */
export function metricAt(metric: MetricSpec, progress: number): number {
  const shape = Math.pow(1 + (progress * 100) / 18, -1.1);
  const floor = Math.pow(1 + 100 / 18, -1.1);
  // Normalised so progress 0 gives `start` and progress 1 gives `final` exactly.
  const t = (1 - shape) / (1 - floor);
  return metric.start + (metric.final - metric.start) * Math.min(1, Math.max(0, t));
}

export function meetsTarget(metric: MetricSpec, value: number): boolean | undefined {
  if (metric.target === undefined) return undefined;
  return metric.direction === "up" ? value >= metric.target : value <= metric.target;
}

/** Cosine learning-rate schedule with linear warmup. */
export function learningRateAt(run: RunSpec, step: number): number {
  if (step < run.warmupSteps) return (run.learningRate * step) / run.warmupSteps;
  const t = (step - run.warmupSteps) / Math.max(1, run.totalSteps - run.warmupSteps);
  return run.learningRate * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, t))));
}

export interface Checkpoint {
  readonly step: number;
  readonly valLoss: number;
  readonly size: string;
  /** Seconds before the current step was reached. */
  readonly ageSeconds: number;
  readonly best: boolean;
}

/**
 * Checkpoints written so far, newest first. Validation loss is the stage's primary curve read
 * at the checkpoint step, with its own noise, and the lowest one is marked best.
 */
export function checkpoints(stage: Stage, step: number, limit = 5): readonly Checkpoint[] {
  const { run } = stage;
  const primary = stage.curves[0]!.curves[0]!;
  const written: { step: number; valLoss: number }[] = [];
  for (let at = run.checkpointEvery; at <= step; at += run.checkpointEvery) {
    const valLoss = curveAt(
      { ...primary, key: `${primary.key}#val`, noise: primary.noise * 1.6 },
      at,
    );
    written.push({ step: at, valLoss: valLoss * 1.08 });
  }
  const best = written.reduce<{ step: number; valLoss: number } | undefined>(
    (low, item) => (!low || item.valLoss < low.valLoss ? item : low),
    undefined,
  );
  return written
    .slice(-limit)
    .reverse()
    .map((item) => ({
      ...item,
      size: run.checkpointSize,
      ageSeconds: (step - item.step) / run.stepsPerSecond,
      best: item.step === best?.step,
    }));
}

export function bestCheckpoint(stage: Stage, step: number): Checkpoint | undefined {
  const all = checkpoints(stage, step, Number.MAX_SAFE_INTEGER);
  return all.find((item) => item.best);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatAgo(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatSteps(step: number): string {
  if (step >= 1000) return `${Math.round(step / 1000)}K`;
  return String(Math.round(step));
}
