/**
 * Promotion gates: the pass/fail criterion each stage metric is judged on.
 *
 * A metric with a target is gated on it. A metric without one, but with a numeric reference
 * that is a comparable quantity (RL's SFT baseline, the teacher's serving figures), is gated
 * on beating that reference. A "retained vs teacher" ratio is reported, not gated: the
 * teacher's 1.0 is the ceiling, not a bar a student is expected to clear.
 */

import { meetsTarget } from "./run";
import type { MetricSpec } from "./stages";

/** The value a metric is gated on, or undefined for a reported-only metric. */
export function gateOf(metric: MetricSpec): number | undefined {
  if (metric.target !== undefined) return metric.target;
  if (typeof metric.reference === "number" && metric.format !== "ratio") {
    return metric.reference;
  }
  return undefined;
}

/**
 * Pass/fail against the gate, judged on the figure as displayed so "0.60" never reads as
 * below a "≥ 0.60" target. Beating a reference must be strict: equal is no improvement.
 */
export function gatePass(metric: MetricSpec, value: number): boolean | undefined {
  const gate = gateOf(metric);
  if (gate === undefined) return undefined;
  const shown = Number(value.toFixed(metric.digits));
  if (metric.target !== undefined) return meetsTarget(metric, shown);
  return metric.direction === "up" ? shown > gate : shown < gate;
}

/**
 * Share of the baseline → goal distance a value has closed: 0 at the metric's starting
 * evaluation, 1 at its target (or, for an ungated metric, its planned endpoint).
 */
export function gapClosed(metric: MetricSpec, value: number): number {
  const goal = metric.target ?? metric.final;
  const span = goal - metric.start;
  return span === 0 ? 1 : (value - metric.start) / span;
}
