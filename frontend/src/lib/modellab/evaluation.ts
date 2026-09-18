/**
 * The evaluation harness of the simulated run.
 *
 * A real training job does not recompute its validation metrics on every optimiser step: it
 * pauses at a fixed cadence, runs the held-out split and publishes one set of numbers that
 * stand until the next evaluation. This module reproduces that behaviour on top of
 * `metricAt`: a metric read at any step reports the value measured at the most recent
 * evaluation, with a little deterministic evaluation noise (a finite held-out split never
 * measures the underlying quality exactly). Everything is a pure function of stage and step,
 * so a paused run shows the same table in every tab.
 */

import { hashString } from "@/lib/canvas/engineering";

import { metricAt } from "./run";
import type { MetricSpec, Stage } from "./stages";

/** Share of a metric's start→final range that evaluation noise may move a reading by. */
const EVAL_NOISE = 0.02;

/** Wall-clock seconds an evaluation pass takes to finish after the step it evaluates. */
export const EVAL_SECONDS = 720;

/** Optimiser steps between evaluations of the held-out split. */
export function evalEvery(stage: Stage): number {
  const { run } = stage;
  switch (stage.id) {
    case "distillation":
      // Every checkpoint is evaluated, including the quantisation-aware deployment pass.
      return run.checkpointEvery;
    default:
      return Math.max(1, Math.round(run.checkpointEvery / 2));
  }
}

function clampStep(stage: Stage, step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(stage.run.totalSteps, Math.max(0, step));
}

/** Optimiser steps the run advances while one evaluation pass is running. */
export function evalLagSteps(stage: Stage): number {
  const rate = stage.run.stepsPerSecond;
  return Number.isFinite(rate) && rate > 0 ? EVAL_SECONDS * rate : 0;
}

/**
 * The step of the most recent evaluation whose results have been published: an evaluation of
 * step s finishes `EVAL_SECONDS` of training later, and until then the previous numbers stand.
 * Step 0 is the baseline evaluation, and a finished run is always evaluated at its final step
 * even when that is off-cadence.
 */
export function lastEvalStep(stage: Stage, step: number): number {
  const at = clampStep(stage, step);
  if (at >= stage.run.totalSteps) return stage.run.totalSteps;
  const every = evalEvery(stage);
  // The epsilon absorbs float error in a fractional step that sits exactly on a boundary.
  return Math.max(0, Math.floor((at - evalLagSteps(stage) + 1e-9) / every) * every);
}

/** The step of the next evaluation to publish, or undefined once the final one has run. */
export function nextEvalStep(stage: Stage, step: number): number | undefined {
  const last = lastEvalStep(stage, step);
  if (last >= stage.run.totalSteps) return undefined;
  return Math.min(stage.run.totalSteps, last + evalEvery(stage));
}

/** Deterministic noise in [-1, 1] for one metric at one evaluation. */
function evalNoise(metric: MetricSpec, stage: Stage, evalStep: number): number {
  return (hashString(`${stage.id}:${metric.label}:eval:${evalStep}`) / 4294967296) * 2 - 1;
}

/** A metric as the evaluation at `evalStep` measured it. */
export function measured(metric: MetricSpec, stage: Stage, evalStep: number): number {
  const base = metricAt(metric, evalStep / stage.run.totalSteps);
  // The baseline evaluation reproduces the starting point exactly (stage 3's SFT baseline).
  if (evalStep <= 0) return base;
  const low = Math.min(metric.start, metric.final);
  const high = Math.max(metric.start, metric.final);
  const value = base + evalNoise(metric, stage, evalStep) * EVAL_NOISE * (high - low);
  return Math.min(high, Math.max(low, value));
}

/**
 * A metric as the eval harness last reported it: constant between evaluations, and changing
 * only when the next evaluation completes.
 */
export function metricAtEval(metric: MetricSpec, stage: Stage, step: number): number {
  return measured(metric, stage, lastEvalStep(stage, step));
}

export interface EvalPoint {
  readonly step: number;
  readonly value: number;
}

/**
 * The last `points` evaluations of a metric up to `step`, oldest first, ending with the
 * evaluation `metricAtEval` reports. Shorter early in the run, when fewer evals exist.
 */
export function metricHistory(
  metric: MetricSpec,
  stage: Stage,
  step: number,
  points = 12,
): readonly EvalPoint[] {
  const last = lastEvalStep(stage, step);
  const every = evalEvery(stage);
  const steps: number[] = [last];
  // An off-cadence final evaluation is followed back onto the regular grid.
  let cursor = last % every === 0 ? last - every : Math.floor(last / every) * every;
  while (steps.length < Math.max(1, Math.floor(points)) && cursor >= 0) {
    steps.push(cursor);
    cursor -= every;
  }
  return steps.reverse().map((at) => ({ step: at, value: measured(metric, stage, at) }));
}

/**
 * TensorBoard's smoothing: an exponential moving average whose zero initialisation is
 * corrected by dividing by 1 − αⁿ, so the first smoothed value equals the first raw value
 * and a constant series stays constant. `alpha` is the weight given to history (0 = none).
 * Non-finite values pass through without disturbing the average.
 */
export function emaSmooth(values: readonly number[], alpha: number): number[] {
  const weight = Math.min(0.999, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  let last = 0;
  let count = 0;
  return values.map((value) => {
    if (!Number.isFinite(value)) return value;
    last = last * weight + (1 - weight) * value;
    count += 1;
    const debias = weight === 0 ? 1 : 1 - Math.pow(weight, count);
    return last / debias;
  });
}

/** Steps at which an evaluation has completed, in (0, step], ascending. */
export function evalMarkers(stage: Stage, step: number): readonly number[] {
  const last = lastEvalStep(stage, step);
  const every = evalEvery(stage);
  const markers: number[] = [];
  for (let at = every; at <= last; at += every) markers.push(at);
  if (last > 0 && markers.at(-1) !== last) markers.push(last);
  return markers;
}

/** Steps at which a checkpoint has been written, in (0, step], ascending. */
export function checkpointMarkers(stage: Stage, step: number): readonly number[] {
  const at = clampStep(stage, step);
  const markers: number[] = [];
  for (let s = stage.run.checkpointEvery; s <= at + 1e-9; s += stage.run.checkpointEvery) {
    markers.push(s);
  }
  return markers;
}
