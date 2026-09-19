import { describe, expect, it } from "vitest";

import {
  accumulation,
  batchGeometry,
  completionFinish,
  completionsDone,
  gradMagnitude,
  groupAdvantages,
  groupRewards,
  klDivergence,
  liveTerms,
  momentOf,
  parameterBudget,
  scheduleSeries,
  stepSegments,
  tokenLosses,
  transferPair,
} from "@/components/modellab/flow/stepFlow";
import { DEFAULT_CONFIG, runProfile } from "@/lib/modellab/config";
import { curveAt, learningRateAt } from "@/lib/modellab/run";
import { trainingSignals } from "@/lib/modellab/signals";
import { STAGES } from "@/lib/modellab/stages";
import { frameAt, phaseAt } from "@/lib/modellab/telemetry";

/**
 * The live architecture figure is clocked by these helpers. They must agree with the run
 * console (same step, same phase, same micro-batch) and with the other figures (same terms).
 */

describe("step flow", () => {
  for (const stage of STAGES) {
    const config = DEFAULT_CONFIG[stage.id];
    const profile = runProfile(stage.id, config);
    const context = { stage, profile, config };
    const step = stage.run.openingStep + 1;
    const frame = frameAt(context, step);
    const micro = accumulation(config, profile.gpus);
    const segments = stepSegments(stage.id, frame, micro);

    it(`${stage.id}: segments tile the step exactly`, () => {
      const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
      expect(total).toBeCloseTo(frame.stepSeconds, 6);
      segments.forEach((segment, index) => {
        if (index === 0) expect(segment.start).toBe(0);
        else {
          const before = segments[index - 1]!;
          expect(segment.start).toBeCloseTo(before.start + before.seconds, 9);
        }
      });
    });

    it(`${stage.id}: every instant falls in one segment, in order`, () => {
      let last = -1;
      for (let i = 0; i <= 200; i += 1) {
        const moment = momentOf(segments, i / 200);
        expect(moment.index).toBeGreaterThanOrEqual(last);
        expect(moment.within).toBeGreaterThanOrEqual(0);
        expect(moment.within).toBeLessThanOrEqual(1);
        last = moment.index;
      }
      expect(momentOf(segments, 0).segment.phase).toBe(segments[0]!.phase);
      expect(momentOf(segments, 1).segment.phase).toBe(segments.at(-1)!.phase);
    });

    it(`${stage.id}: the phase at the step's edges matches the telemetry`, () => {
      // Interleaving only reorders micro-batches inside the step; the first and last phases
      // are the same ones phaseAt reports.
      const first = frame.phases[phaseAt(frame, 0).index]!.id;
      const lastPhase = frame.phases[phaseAt(frame, 1).index]!.id;
      expect(momentOf(segments, 0).segment.phase).toBe(first);
      expect(momentOf(segments, 1).segment.phase).toBe(lastPhase);
    });

    it(`${stage.id}: live terms sum to their total and agree with figure 04`, () => {
      const terms = liveTerms(stage, step);
      const sum = terms.terms.reduce((total, term) => total + term.contribution, 0);
      expect(terms.total).toBeCloseTo(sum, 12);
      const signals = trainingSignals(stage, step);
      if (signals.kind !== "unweighted") expect(terms.total).toBeCloseTo(signals.total!, 9);
    });
  }

  it("distillation terms reproduce the logged total objective", () => {
    const stage = STAGES.find((item) => item.id === "distillation")!;
    const total = stage.curves[0]!.curves[0]!;
    for (const step of [100, 5000, 21_500, 60_000]) {
      expect(liveTerms(stage, step).total).toBeCloseTo(curveAt(total, step, stage), 9);
    }
  });

  it("rollout completions finish on the console's long-tailed curve", () => {
    expect(completionsDone(0, 512)).toBe(0);
    expect(completionsDone(1, 512)).toBe(512);
    for (let k = 0; k < 8; k += 1) {
      const at = completionFinish(k, 8);
      expect(completionsDone(at + 1e-9, 8)).toBeGreaterThanOrEqual(k + 1);
    }
    expect(completionFinish(7, 8)).toBeCloseTo(1, 9);
  });

  it("group advantages are normalised, or all zero for a zero-variance group", () => {
    for (let step = 1; step < 60; step += 1) {
      const adv = groupAdvantages(step, 0.6, 0.3, 8);
      expect(adv).toHaveLength(8);
      const mean = adv.reduce((a, b) => a + b, 0) / 8;
      expect(Math.abs(mean)).toBeLessThan(1e-9);
      const zero = adv.every((value) => value === 0);
      if (!zero) {
        const variance = adv.reduce((a, b) => a + b * b, 0) / 8;
        expect(variance).toBeCloseTo(1, 6);
      }
    }
    expect(groupAdvantages(7, 0.6, 1, 8).every((value) => value === 0)).toBe(true);
  });

  it("group advantages are the group's own rewards, normalised", () => {
    for (let step = 1; step < 40; step += 1) {
      const rewards = groupRewards(step, 0.62, 0.2, 8);
      const adv = groupAdvantages(step, 0.62, 0.2, 8);
      const mean = rewards.reduce((a, b) => a + b, 0) / 8;
      const std = Math.sqrt(rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / 8);
      rewards.forEach((reward, k) => {
        expect(reward).toBeGreaterThanOrEqual(0);
        expect(reward).toBeLessThanOrEqual(1);
        expect(adv[k]).toBeCloseTo(std > 1e-6 ? (reward - mean) / std : 0, 9);
      });
    }
  });
});

describe("what figure 03 draws inside a step", () => {
  for (const stage of STAGES) {
    const config = DEFAULT_CONFIG[stage.id];
    const profile = runProfile(stage.id, config);
    const context = { stage, profile, config };

    it(`${stage.id}: gradient marks follow the logged grad_norm and its clip`, () => {
      for (const step of [1, 40, stage.run.openingStep, stage.run.totalSteps]) {
        const frame = frameAt(context, step);
        const grad = gradMagnitude(frame);
        if (Number.isFinite(frame.gradNorm)) expect(grad.norm).toBe(frame.gradNorm);
        expect(grad.clipped).toBe(frame.clipped);
        expect(grad.width).toBeGreaterThanOrEqual(1);
        expect(grad.width).toBeLessThanOrEqual(4.3 + 1e-9);
      }
    });

    it(`${stage.id}: batch geometry multiplies out to the global batch and tokens`, () => {
      const geometry = batchGeometry(stage.id, config, profile);
      expect(geometry.ranks).toBe(config.nodes * config.gpusPerNode);
      expect(geometry.accumulation).toBe(accumulation(config, profile.gpus));
      expect(geometry.ranks * geometry.micro * geometry.accumulation).toBe(
        config.globalBatch,
      );
      expect(geometry.sequence * geometry.group).toBeCloseTo(profile.tokensPerSample, 0);
      expect(geometry.tokensPerStep).toBe(profile.tokensPerSample * config.globalBatch);
    });

    it(`${stage.id}: trainable parameters sum to the planner's count`, () => {
      for (const trainable of ["lora", "full"] as const) {
        const variant = { ...config, trainable };
        const plan = runProfile(stage.id, variant);
        const parts = parameterBudget(stage.id, variant, plan);
        const trained = parts
          .filter((part) => part.trainable)
          .reduce((sum, part) => sum + part.billions, 0);
        expect(trained).toBeCloseTo(plan.trainableB, 9);
        if (trainable === "lora") {
          expect(parts.find((part) => part.id === "base")!.trainable).toBe(false);
        }
        expect(parts.some((part) => part.id === "teacher")).toBe(
          stage.id === "distillation",
        );
      }
    });

    it(`${stage.id}: the drawn schedule is the optimizer's schedule`, () => {
      const series = scheduleSeries(stage.run);
      expect(series[0]!.step).toBe(0);
      expect(series.at(-1)!.step).toBe(stage.run.totalSteps);
      for (const point of series) {
        expect(point.lr).toBe(learningRateAt(stage.run, point.step));
      }
      const peak = Math.max(...series.map((point) => point.lr));
      expect(peak).toBeCloseTo(stage.run.learningRate, 12);
    });
  }

  it("per-position losses average exactly to the live term", () => {
    for (const mean of [0.05, 0.44, 1.5, 7.2]) {
      const losses = tokenLosses("mlm", 16_420, mean, 14);
      expect(losses).toHaveLength(14);
      expect(losses.reduce((a, b) => a + b, 0) / 14).toBeCloseTo(mean, 9);
      expect(losses.every((value) => value > 0)).toBe(true);
    }
  });

  it("the transfer pair carries exactly the live KL and hidden-state MSE", () => {
    const stage = STAGES.find((item) => item.id === "distillation")!;
    for (const step of [100, 5000, 21_500, 60_000]) {
      const terms = liveTerms(stage, step);
      const kl = terms.terms.find((term) => term.key === "kd-kl")!.value;
      const mse = terms.terms.find((term) => term.key === "hidden")!.value;
      const pair = transferPair(step, kl, mse);
      expect(pair.kl).toBeCloseTo(kl, 6);
      expect(klDivergence(pair.teacher, pair.student)).toBeCloseTo(kl, 6);
      expect(pair.mse).toBeCloseTo(mse, 9);
      expect(pair.teacher.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(pair.student.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    // A smaller KL puts the student closer to the teacher, bin by bin.
    const near = transferPair(9, 0.01, 0.01);
    const far = transferPair(9, 1.2, 0.5);
    const gap = (pair: typeof near) =>
      pair.teacher.reduce((sum, p, i) => sum + Math.abs(p - pair.student[i]!), 0);
    expect(gap(near)).toBeLessThan(gap(far));
  });
});
