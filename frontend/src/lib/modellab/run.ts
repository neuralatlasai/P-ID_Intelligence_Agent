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

import { perturbation } from "./incidents";
import { fbm, seedOf, white } from "./noise";
import type { CurveSpec, MetricSpec, RunSpec, Stage } from "./stages";

export type RunStatus = "running" | "paused";

/** Where the run was at a moment, and whether it has been moving since. */
export interface RunControl {
  readonly status: RunStatus;
  readonly step: number;
  /** Epoch milliseconds the step was recorded at. */
  readonly at: number;
  /**
   * Replay speed: training seconds per wall-clock second. 1 is real time. Faster replay lets
   * a viewer watch hours of a run's evolution in minutes; it changes nothing about the run's
   * modelled throughput, which every card still reports in real training time.
   */
  readonly speed?: number;
}

/** The replay speeds offered. Real time first: it is the honest default. */
export const REPLAY_SPEEDS = [1, 60, 600] as const;

export function openingControl(run: RunSpec, now: number, speed = 1): RunControl {
  return { status: "running", step: run.openingStep, at: now, speed };
}

/** The step the run has reached at `now`. O(1). */
export function stepAt(control: RunControl, run: RunSpec, now: number): number {
  const moved =
    control.status === "running"
      ? (Math.max(0, now - control.at) / 1000) * run.stepsPerSecond * (control.speed ?? 1)
      : 0;
  return Math.min(run.totalSteps, control.step + moved);
}

export function pause(control: RunControl, run: RunSpec, now: number): RunControl {
  return {
    status: "paused",
    step: stepAt(control, run, now),
    at: now,
    speed: control.speed,
  };
}

export function resume(control: RunControl, run: RunSpec, now: number): RunControl {
  const step = stepAt(control, run, now);
  // A finished stage starts again from zero: that is what "run training stage" means then.
  return {
    status: "running",
    step: step >= run.totalSteps ? 0 : step,
    at: now,
    speed: control.speed,
  };
}

/** Change replay speed without moving the run: rebase at the current step, then continue. */
export function withSpeed(
  control: RunControl,
  run: RunSpec,
  now: number,
  speed: number,
): RunControl {
  return { ...control, step: stepAt(control, run, now), at: now, speed };
}

/** Enough of a stage for a curve to know its run's incidents, epochs and sibling curves. */
export type CurveContext = Pick<Stage, "id" | "run" | "curves">;

/** Multiplicative level change per epoch boundary for a multi-epoch training loss. */
const EPOCH_DROP = 0.8;

/**
 * How a curve is being read. `train`: the value on the training batch at that step, with
 * per-step sampling noise and the run's incidents. `heldout`: the value a held-out evaluation
 * would report — smooth, incident-free, a little worse than training, and for a multi-epoch
 * objective, turning up in the final epoch while the training loss is still falling.
 */
export type CurveMode = "train" | "heldout";

/** Held-out loss sits above training loss; held-out reward below training reward. */
const GENERALISATION_GAP = { loss: 1.06, reward: 0.97 } as const;

/**
 * The trajectory a curve follows before noise and incidents: a power-law approach from
 * `start` to `end`, the shape both loss and score curves take in practice, bent by the
 * run's epoch structure where the curve asks for it.
 */
function trend(
  curve: CurveSpec,
  step: number,
  context: CurveContext | undefined,
  mode: CurveMode,
): number {
  const settle = Math.pow(1 + step / curve.tau, -1.35);
  let value = curve.end + (curve.start - curve.end) * settle;
  const epochs = context?.run.epochs ?? 1;
  if (context && curve.shape === "epochs" && epochs > 1) {
    const epoch = (step / context.run.totalSteps) * epochs;
    const whole = Math.min(epochs - 1, Math.floor(epoch));
    if (mode === "train" && whole > 0) {
      // Each new epoch revisits examples the model has already fitted, so the training loss
      // steps down at the boundary instead of continuing smoothly. The step is softened over
      // the first 1.5 % of the epoch, as the first reshuffled batches arrive.
      const into = epoch - whole;
      value *= Math.pow(EPOCH_DROP, whole - 1 + Math.min(1, into / 0.015));
    } else if (mode === "heldout") {
      // Held-out loss stops improving once training loss is mostly memorisation.
      const overfit = Math.max(0, epoch - (epochs - 1));
      value *= 1 + 0.085 * Math.pow(overfit, 1.25);
    }
  }
  if (mode === "heldout" && (curve.response === "loss" || curve.response === "reward")) {
    value *= GENERALISATION_GAP[curve.response];
  }
  return value;
}

/**
 * A curve's value at a step.
 *
 * Training-time signals carry per-step sampling noise — each optimiser step sees a different
 * batch — on top of a slow wander; held-out signals carry only a smaller wander. Both shrink
 * as training settles. Given the run's context, a training reading also carries the run's
 * incidents (see incidents.ts): a loss spike in the timeline is a spike in this curve, so
 * every chart, card and log line that reads it agrees on what happened. A total objective
 * (`sumOf`) is computed from its terms, so `L = Σ λᵢ Lᵢ` holds at every step.
 */
export function curveAt(
  curve: CurveSpec,
  step: number,
  context?: CurveContext,
  requested: CurveMode = "train",
): number {
  const mode: CurveMode = curve.evaluation ? "heldout" : requested;
  if (curve.sumOf && context) {
    const siblings = context.curves.flatMap((tab) => tab.curves);
    let total = 0;
    for (const term of curve.sumOf) {
      const part = siblings.find((item) => item.key === term.key);
      if (part && !part.sumOf) total += term.weight * curveAt(part, step, context, mode);
    }
    return total;
  }
  const settle = Math.pow(1 + step / curve.tau, -1.35);
  const seed = seedOf(curve.key);
  const scale = context ? Math.max(40, context.run.totalSteps / 70) : 900;
  const amplitude = curve.noise * (0.4 + 0.6 * settle);
  const value = trend(curve, step, context, mode);
  if (mode === "heldout") {
    return value * (1 + fbm(seed ^ 0x7f4a7c15, step / scale) * amplitude * 0.35);
  }
  const wander = fbm(seed, step / scale) * amplitude * 0.6;
  const sample = curve.response
    ? white(seed ^ 0x5bd1e995, Math.floor(step)) * amplitude
    : 0;
  const trained = value * (1 + wander + sample);
  return context ? trained * perturbation(context, curve.response, step) : trained;
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
  if (metric.from !== undefined) {
    // A discrete change: nothing until the event, then a short settle as evaluations of the
    // new artefact accumulate.
    const into = Math.min(1, Math.max(0, (progress - metric.from) / 0.08));
    const eased = into * into * (3 - 2 * into);
    return metric.start + (metric.final - metric.start) * eased;
  }
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

/**
 * True when a stage's checkpoint validation value `a` beats `b`. Stage 3 checkpoints are
 * scored by held-out reward, where higher is better; every other stage by a loss or KL.
 */
export function isBetter(stage: Stage, a: number, b: number): boolean {
  return stage.id === "rl" ? a > b : a < b;
}

/**
 * The held-out value written with a checkpoint at `step`: the stage's primary curve with its
 * own evaluation noise, a little worse than the training batch reads (a validation loss sits
 * above the training loss; a held-out reward below the training reward).
 */
export function validationAt(stage: Stage, step: number): number {
  // Measured on a fixed held-out split: no batch noise, no training incidents, the
  // generalisation gap applied — and, for a multi-epoch run, the held-out trajectory that
  // turns up in the final epoch. That is why the best checkpoint of a three-epoch fine-tune
  // is usually not the last one.
  return curveAt(stage.curves[0]!.curves[0]!, step, stage, "heldout");
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
  const written: { step: number; valLoss: number }[] = [];
  for (let at = run.checkpointEvery; at <= step + 1e-9; at += run.checkpointEvery) {
    written.push({ step: at, valLoss: validationAt(stage, at) });
  }
  const best = written.reduce<{ step: number; valLoss: number } | undefined>(
    (top, item) => (!top || isBetter(stage, item.valLoss, top.valLoss) ? item : top),
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
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours ? `${days}d ${hours}h ago` : `${days}d ago`;
}

export function formatSteps(step: number): string {
  if (step >= 1000) return `${Math.round(step / 1000)}K`;
  return String(Math.round(step));
}
