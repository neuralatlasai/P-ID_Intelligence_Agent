import { describe, expect, it } from "vitest";

import {
  checkpointMarkers,
  EVAL_SECONDS,
  emaSmooth,
  evalEvery,
  evalLagSteps,
  evalMarkers,
  lastEvalStep,
  metricAtEval,
  metricHistory,
  nextEvalStep,
} from "@/lib/modellab/evaluation";
import { metricAt } from "@/lib/modellab/run";
import { STAGES, type StageId } from "@/lib/modellab/stages";

const stage = (id: StageId) => STAGES.find((item) => item.id === id)!;

/**
 * The eval harness decides when the metrics table may change. These tests pin that it only
 * changes when an evaluation completes, that smoothing matches TensorBoard's debiased EMA,
 * and that nothing reports an evaluation from the future.
 */
describe("evaluation cadence", () => {
  it("evaluates each stage at its published cadence", () => {
    expect(evalEvery(stage("pretraining"))).toBe(
      stage("pretraining").run.checkpointEvery / 2,
    );
    expect(evalEvery(stage("sft"))).toBe(stage("sft").run.checkpointEvery / 2);
    expect(evalEvery(stage("rl"))).toBe(2500);
    expect(evalEvery(stage("distillation"))).toBe(stage("distillation").run.checkpointEvery);
  });

  it("reports the last and next evaluation around a step", () => {
    // With no step rate there is no evaluation lag, so boundaries are exact.
    const instant = (id: StageId) => ({
      ...stage(id),
      run: { ...stage(id).run, stepsPerSecond: 0 },
    });
    const pre = instant("pretraining");
    expect(lastEvalStep(pre, 68_240.7)).toBe(68_000);
    expect(nextEvalStep(pre, 68_240.7)).toBe(69_000);
    expect(lastEvalStep(pre, 999.99)).toBe(0);
    expect(lastEvalStep(pre, 1000)).toBe(1000);
    expect(lastEvalStep(instant("rl"), 53_556)).toBe(52_500);
    expect(lastEvalStep(pre, pre.run.totalSteps + 50)).toBe(pre.run.totalSteps);
    expect(nextEvalStep(pre, pre.run.totalSteps)).toBeUndefined();
  });
});

describe("evaluation publication", () => {
  it("publishes an evaluation only after the pass has run for EVAL_SECONDS", () => {
    const pre = stage("pretraining");
    const lag = evalLagSteps(pre);
    expect(lag).toBeCloseTo(EVAL_SECONDS * pre.run.stepsPerSecond, 9);
    const every = evalEvery(pre);
    const boundary = 68_000;
    expect(lastEvalStep(pre, boundary + lag * 0.5)).toBe(boundary - every);
    expect(lastEvalStep(pre, boundary + lag + 0.01)).toBe(boundary);
  });
});

/** A stage with no step rate: evaluations publish on their boundary, with no pass lag. */
const instantStage = (id: StageId) => ({
  ...stage(id),
  run: { ...stage(id).run, stepsPerSecond: 0 },
});

describe("metricAtEval", () => {
  it("holds constant between evaluations and changes when one lands", () => {
    for (const item of STAGES.map((entry) => instantStage(entry.id))) {
      const every = evalEvery(item);
      const at = every * 20;
      for (const metric of item.metrics) {
        const settled = metricAtEval(metric, item, at);
        expect(metricAtEval(metric, item, at + every * 0.3)).toBe(settled);
        expect(metricAtEval(metric, item, at + every - 0.01)).toBe(settled);
      }
      const changed = item.metrics.some(
        (metric) =>
          metricAtEval(metric, item, at + every) !== metricAtEval(metric, item, at),
      );
      expect(changed).toBe(true);
    }
  });

  it("stays close to the underlying curve and reproduces the baseline exactly", () => {
    const rl = instantStage("rl");
    for (const metric of rl.metrics) {
      expect(metricAtEval(metric, rl, 10)).toBe(metric.start);
      const value = metricAtEval(metric, rl, 60_000);
      const range = Math.abs(metric.final - metric.start);
      expect(Math.abs(value - metricAt(metric, 0.6))).toBeLessThanOrEqual(range * 0.021);
    }
  });

  it("is deterministic", () => {
    const pre = stage("pretraining");
    const metric = pre.metrics[0]!;
    expect(metricAtEval(metric, pre, 68_240)).toBe(metricAtEval(metric, pre, 68_999));
  });
});

describe("metricHistory", () => {
  it("returns past evaluations oldest first, ending at the last one", () => {
    const pre = stage("pretraining");
    const metric = pre.metrics[0]!;
    const history = metricHistory(metric, pre, 68_240, 12);
    expect(history).toHaveLength(12);
    expect(history.map((point) => point.step)).toEqual(
      Array.from({ length: 12 }, (_, index) => 57_000 + index * 1000),
    );
    expect(history.at(-1)!.value).toBe(metricAtEval(metric, pre, 68_240));
  });

  it("is shorter early in the run", () => {
    const pre = stage("pretraining");
    const history = metricHistory(pre.metrics[0]!, pre, 2500, 12);
    expect(history.map((point) => point.step)).toEqual([0, 1000, 2000]);
  });
});

describe("emaSmooth", () => {
  it("is the identity with no smoothing", () => {
    expect(emaSmooth([3, 1, 4, 1, 5], 0)).toEqual([3, 1, 4, 1, 5]);
  });

  it("debiases the zero initialisation like TensorBoard", () => {
    const alpha = 0.6;
    const values = [10, 2, 6];
    const smoothed = emaSmooth(values, alpha);
    expect(smoothed[0]).toBeCloseTo(10, 12);
    // Hand-computed: last₁ = 4, last₂ = 3.2; debiased by 1 − 0.6² = 0.64.
    const last2 = 0.6 * 4 + 0.4 * 2;
    expect(smoothed[1]).toBeCloseTo(last2 / (1 - alpha ** 2), 12);
    const last3 = 0.6 * last2 + 0.4 * 6;
    expect(smoothed[2]).toBeCloseTo(last3 / (1 - alpha ** 3), 12);
  });

  it("keeps a constant series constant and preserves length", () => {
    const smoothed = emaSmooth(
      Array.from({ length: 50 }, () => 0.25),
      0.99,
    );
    expect(smoothed).toHaveLength(50);
    for (const value of smoothed) expect(value).toBeCloseTo(0.25, 12);
  });
});

describe("markers", () => {
  it("never places an evaluation or checkpoint beyond the current step", () => {
    for (const item of STAGES) {
      const step = item.run.openingStep + 123.4;
      const evals = evalMarkers(item, step);
      expect(evals.length).toBeGreaterThan(0);
      for (const at of evals) expect(at).toBeLessThanOrEqual(step);
      expect([...evals].sort((a, b) => a - b)).toEqual(evals);
      expect(evals.at(-1)).toBe(lastEvalStep(item, step));
      for (const at of checkpointMarkers(item, step)) expect(at).toBeLessThanOrEqual(step);
    }
    expect(evalMarkers(stage("pretraining"), 500)).toEqual([]);
  });
});
