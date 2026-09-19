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
    // A 1,200-step GRPO run evaluates every 25 steps; a fixed 2,500 would never fire.
    expect(evalEvery(stage("rl"))).toBe(stage("rl").run.checkpointEvery / 2);
    expect(evalEvery(stage("rl"))).toBeLessThan(stage("rl").run.totalSteps / 10);
    expect(evalEvery(stage("distillation"))).toBe(
      stage("distillation").run.checkpointEvery,
    );
  });

  it("reports the last and next evaluation around a step", () => {
    // With no step rate there is no evaluation lag, so boundaries are exact.
    const instant = (id: StageId) => ({
      ...stage(id),
      run: { ...stage(id).run, stepsPerSecond: 0 },
    });
    const pre = instant("pretraining");
    const every = evalEvery(pre);
    const boundary = every * 32;
    expect(lastEvalStep(pre, boundary + every * 0.48)).toBe(boundary);
    expect(nextEvalStep(pre, boundary + every * 0.48)).toBe(boundary + every);
    expect(lastEvalStep(pre, every - 0.01)).toBe(0);
    expect(lastEvalStep(pre, every)).toBe(every);
    const rl = instant("rl");
    const rlEvery = evalEvery(rl);
    expect(lastEvalStep(rl, rlEvery * 24 + 12)).toBe(rlEvery * 24);
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
    const boundary = every * 32;
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
      // An evaluation boundary about 60 % of the way through the run.
      const every = evalEvery(rl);
      const at = Math.round((rl.run.totalSteps * 0.6) / every) * every;
      const value = metricAtEval(metric, rl, at);
      const range = Math.abs(metric.final - metric.start);
      expect(
        Math.abs(value - metricAt(metric, at / rl.run.totalSteps)),
      ).toBeLessThanOrEqual(range * 0.021);
    }
  });

  it("is deterministic", () => {
    const pre = stage("pretraining");
    const metric = pre.metrics[0]!;
    // Two readings inside one publication window report the same evaluation.
    const every = evalEvery(pre);
    const published = every * 32 + evalLagSteps(pre) + 1;
    expect(metricAtEval(metric, pre, published)).toBe(
      metricAtEval(metric, pre, published + every * 0.5),
    );
  });
});

describe("metricHistory", () => {
  it("returns past evaluations oldest first, ending at the last one", () => {
    const pre = stage("pretraining");
    const metric = pre.metrics[0]!;
    const at = pre.run.openingStep;
    const every = evalEvery(pre);
    const last = lastEvalStep(pre, at);
    const history = metricHistory(metric, pre, at, 12);
    expect(history).toHaveLength(12);
    expect(history.map((point) => point.step)).toEqual(
      Array.from({ length: 12 }, (_, index) => last - (11 - index) * every),
    );
    expect(history.at(-1)!.value).toBe(metricAtEval(metric, pre, at));
  });

  it("is shorter early in the run", () => {
    const pre = stage("pretraining");
    const every = evalEvery(pre);
    // Two and a half evaluation intervals in, plus the publication lag.
    const history = metricHistory(
      pre.metrics[0]!,
      pre,
      every * 2.5 + evalLagSteps(pre),
      12,
    );
    expect(history.map((point) => point.step)).toEqual([0, every, every * 2]);
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

describe("promotion gates", () => {
  it("gates on the target, else on beating a comparable reference", async () => {
    const { gateOf, gatePass, gapClosed } = await import("@/lib/modellab/gates");
    const pre = stage("pretraining");
    const r1 = pre.metrics.find((metric) =>
      metric.label.startsWith("Cross-modal retrieval R@1"),
    )!;
    expect(gateOf(r1)).toBe(0.6);
    // Judged on the displayed figure: 0.597 shows as "0.60" and passes a ≥ 0.60 target.
    expect(gatePass(r1, 0.597)).toBe(true);
    expect(gatePass(r1, 0.58)).toBe(false);
    expect(gapClosed(r1, r1.start)).toBe(0);
    expect(gapClosed(r1, 0.6)).toBeCloseTo(1, 12);

    const rl = stage("rl");
    const pass1 = rl.metrics.find((metric) => metric.label.startsWith("pass@1"))!;
    // No target: the SFT baseline is the bar, and matching it is not an improvement.
    expect(gateOf(pass1)).toBe(pass1.reference);
    expect(gatePass(pass1, pass1.start)).toBe(false);
    expect(gatePass(pass1, pass1.final)).toBe(true);
    const winRate = rl.metrics.find((metric) =>
      metric.label.startsWith("Policy win-rate"),
    )!;
    expect(gateOf(winRate)).toBeUndefined();

    const kd = stage("distillation");
    // A retained-vs-teacher ratio is reported, never gated on the teacher's 1.0.
    for (const metric of kd.metrics.filter((item) => item.format === "ratio")) {
      expect(gateOf(metric)).toBeUndefined();
    }
    const ttft = kd.metrics.find((metric) =>
      metric.label.startsWith("Time to first token"),
    )!;
    expect(gatePass(ttft, 140)).toBe(true);
    expect(gatePass(ttft, 240)).toBe(false);
  });
});

describe("evaluation and handoff cards", () => {
  it("render as figures for every stage, with the handoff controls intact", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DEFAULT_CONFIG, runProfile } = await import("@/lib/modellab/config");
    const { MetricsLiveCard } = await import("@/components/modellab/MetricsLiveCard");
    const { CurvesLiveCard } = await import("@/components/modellab/CurvesLiveCard");
    const { CheckpointsLiveCard } =
      await import("@/components/modellab/CheckpointsLiveCard");
    const { DeploymentLiveCard } = await import("@/components/modellab/DeploymentLiveCard");
    const { ArtifactsRow, RewardBreakdownCard, TeacherStudentRuntimeCard } =
      await import("@/components/modellab/Cards");
    const NOW = Date.UTC(2026, 8, 16, 15, 0, 0);
    for (const base of STAGES) {
      const config = DEFAULT_CONFIG[base.id];
      const profile = runProfile(base.id, config);
      const item = {
        ...base,
        run: { ...base.run, stepsPerSecond: profile.stepsPerSecond },
      };
      for (const step of [0, item.run.openingStep, item.run.totalSteps]) {
        const progress = step / item.run.totalSteps;
        const props = {
          stage: item,
          step,
          progress,
          now: NOW,
          running: true,
          config,
          profile,
        };
        const html = [
          renderToStaticMarkup(createElement(MetricsLiveCard, props)),
          renderToStaticMarkup(createElement(CurvesLiveCard, props)),
          renderToStaticMarkup(createElement(CheckpointsLiveCard, props)),
          item.id === "distillation"
            ? renderToStaticMarkup(createElement(DeploymentLiveCard, props))
            : "",
          item.teacherStudent
            ? renderToStaticMarkup(
                createElement(TeacherStudentRuntimeCard, { stage: item, step }),
              )
            : "",
          item.rewards
            ? renderToStaticMarkup(
                createElement(RewardBreakdownCard, {
                  stage: item,
                  step,
                  progress,
                  liveCount: 0,
                }),
              )
            : "",
        ].join("");
        expect(html).not.toContain("NaN");
        expect(html).toContain('role="img"');
        // No data tables left in these cards except the visually hidden accessible one.
        expect(html.match(/<table/g)?.length ?? 0).toBeLessThanOrEqual(
          item.teacherStudent ? 1 : 0,
        );

        const outputs = renderToStaticMarkup(
          createElement(ArtifactsRow, {
            stage: item,
            progress,
            step,
            sheet: "main-steam.png",
            verifications: [],
            now: NOW,
            running: true,
          }),
        );
        expect(outputs).not.toContain("NaN");
        expect(outputs).toContain(item.experimentId);
        for (const spec of item.outputs) {
          if (spec.download === "weights" && progress < spec.readyAt) {
            expect(outputs).toContain(`${spec.title}: `);
          }
        }
      }
    }
  });
});
