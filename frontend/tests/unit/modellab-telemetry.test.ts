import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@/lib/modellab/config";
import { incidentsBetween, perturbation } from "@/lib/modellab/incidents";
import {
  curveAt,
  REPLAY_SPEEDS,
  stepAt,
  validationAt,
  withSpeed,
  type RunControl,
} from "@/lib/modellab/run";
import {
  effectiveStage,
  freshSession,
  loadSession,
  replaySpeedOf,
  SESSION_KEY,
  setReplaySpeed,
} from "@/lib/modellab/session";
import { STAGES, type StageId } from "@/lib/modellab/stages";
import {
  frameAt,
  frameSource,
  historyLines,
  logTail,
  MAX_GRAD_NORM,
  sampleSteps,
  trainerLine,
  type TelemetryContext,
} from "@/lib/modellab/telemetry";

const NOW = Date.UTC(2026, 8, 18, 12);

function context(id: StageId): TelemetryContext {
  const session = freshSession(NOW);
  const plan = STAGES.find((stage) => stage.id === id)!;
  const { stage, profile } = effectiveStage(plan, session.applied[id]);
  return { stage, profile, config: DEFAULT_CONFIG[id] };
}

const ALL: readonly StageId[] = ["pretraining", "sft", "rl", "distillation"];

/**
 * The property this model exists for: what the run log says happened is what the charts
 * show. Before it, the log narrated spikes the analytic curves could not draw.
 */
describe("the log and the charts agree", () => {
  for (const id of ALL) {
    it(`${id}: every trainer line prints the plotted value at its step`, () => {
      const ctx = context(id);
      const primary = ctx.stage.curves[0]!.curves[0]!;
      const incidents = incidentsBetween(ctx.stage, 1, ctx.stage.run.totalSteps);
      const steps = [
        1,
        ctx.stage.run.openingStep,
        ...incidents.slice(0, 20).flatMap((incident) => [incident.step, incident.step + 1]),
      ];
      for (const step of steps) {
        const frame = frameAt(ctx, step);
        const plotted = curveAt(primary, step, ctx.stage);
        expect(frame.loss).toBe(plotted);
        const digits = id === "rl" ? 3 : 4;
        expect(trainerLine(ctx, frame)).toContain(plotted.toFixed(digits));
      }
    });
  }

  it("a loss spike in the timeline is a spike in the plotted loss", () => {
    const ctx = context("pretraining");
    const spikes = incidentsBetween(ctx.stage, 1, ctx.stage.run.totalSteps).filter(
      (incident) => incident.kind === "loss-spike",
    );
    expect(spikes.length).toBeGreaterThan(0);
    for (const spike of spikes) {
      expect(perturbation(ctx.stage, "loss", spike.step - 1)).toBeLessThanOrEqual(
        perturbation(ctx.stage, "loss", spike.step),
      );
      expect(perturbation(ctx.stage, "loss", spike.step)).toBeGreaterThan(
        1 + spike.magnitude * 0.3,
      );
      // Relaxed again once the incident has run its course — unless a later spike overlaps.
      const after = spike.step + spike.duration + 1;
      const overlapped = spikes.some(
        (other) =>
          other !== spike && other.step <= after && after < other.step + other.duration,
      );
      if (!overlapped) expect(perturbation(ctx.stage, "loss", after)).toBe(1);
    }
  });

  it("a full-run chart never samples past a spike the log reports", () => {
    const ctx = context("pretraining");
    const steps = new Set(sampleSteps(ctx.stage, 1, ctx.stage.run.totalSteps, 360));
    for (const incident of incidentsBetween(ctx.stage, 1, ctx.stage.run.totalSteps)) {
      expect(steps.has(incident.step)).toBe(true);
    }
  });

  it("held-out readings carry no training incidents", () => {
    const ctx = context("pretraining");
    const spike = incidentsBetween(ctx.stage, 1, ctx.stage.run.totalSteps).find(
      (incident) => incident.kind === "loss-spike" && incident.magnitude > 0.3,
    )!;
    const before = validationAt(ctx.stage, spike.step - 1);
    const during = validationAt(ctx.stage, spike.step);
    expect(during / before).toBeLessThan(1.02);
  });
});

describe("objective arithmetic", () => {
  it("a total objective is exactly the weighted sum of its terms", () => {
    for (const id of ALL) {
      const { stage } = context(id);
      const curves = stage.curves.flatMap((tab) => tab.curves);
      for (const total of curves.filter((curve) => curve.sumOf)) {
        for (const step of [10, stage.run.openingStep, stage.run.totalSteps - 1]) {
          const expected = total.sumOf!.reduce(
            (sum, term) =>
              sum +
              term.weight *
                curveAt(
                  curves.find((curve) => curve.key === term.key)!,
                  step,
                  stage,
                  total.evaluation ? "heldout" : "train",
                ),
            0,
          );
          expect(curveAt(total, step, stage)).toBeCloseTo(expected, 12);
        }
      }
    }
  });

  it("losses sit where a strong base model's continued training puts them", () => {
    const { stage } = context("pretraining");
    const next = stage.curves[0]!.curves.find((curve) => curve.key === "mlm")!;
    const end = curveAt(next, stage.run.totalSteps, stage, "heldout");
    // Not the near-zero values of a memorised run.
    expect(end).toBeGreaterThan(1);
    expect(end).toBeLessThan(2);
  });
});

describe("step physics", () => {
  for (const id of ALL) {
    it(`${id}: phases add up and the mean step matches planned throughput`, () => {
      const ctx = context(id);
      const source = frameSource(ctx);
      let total = 0;
      const count = Math.min(2000, ctx.stage.run.totalSteps - 1);
      for (let step = 1; step <= count; step += 1) {
        const frame = source.frame(step);
        const phases = frame.phases.reduce((sum, phase) => sum + phase.seconds, 0);
        expect(phases).toBeCloseTo(frame.stepSeconds, 9);
        total += frame.stepSeconds;
      }
      const planned = 1 / ctx.profile.stepsPerSecond;
      expect(total / count / planned).toBeGreaterThan(0.93);
      expect(total / count / planned).toBeLessThan(1.07);
    });
  }

  it("utilisation is in the range well-tuned FSDP jobs report", () => {
    for (const id of ["pretraining", "sft", "distillation"] as const) {
      const ctx = context(id);
      const frame = frameAt(ctx, ctx.stage.run.openingStep);
      expect(frame.mfu).toBeGreaterThan(0.3);
      expect(frame.mfu).toBeLessThan(0.45);
    }
  });

  it("reinforcement learning is dominated by generation", () => {
    const ctx = context("rl");
    const frame = frameAt(ctx, ctx.stage.run.openingStep);
    const gen = frame.phases.find((phase) => phase.id === "gen")!.seconds;
    expect(gen / frame.stepSeconds).toBeGreaterThan(0.35);
    expect(frame.stepSeconds).toBeGreaterThan(120);
  });

  it("clipping is reported exactly when the norm exceeds max_norm", () => {
    const ctx = context("pretraining");
    for (let step = 1; step < 3000; step += 1) {
      const frame = frameAt(ctx, step);
      if (frame.skipped) {
        expect(Number.isNaN(frame.gradNorm)).toBe(true);
        expect(trainerLine(ctx, frame)).toContain("grad_norm: nan");
      } else {
        expect(frame.clipped).toBe(frame.gradNorm > MAX_GRAD_NORM);
      }
    }
  });

  it("a restart happens only in the step after a checkpoint", () => {
    for (const id of ALL) {
      const { stage } = context(id);
      for (const incident of incidentsBetween(stage, 1, stage.run.totalSteps)) {
        if (incident.kind === "job-restart") {
          expect((incident.step - 1) % stage.run.checkpointEvery).toBe(0);
        }
      }
    }
  });

  it("is deterministic", () => {
    const ctx = context("distillation");
    expect(frameAt(ctx, 12_345)).toEqual(frameAt(ctx, 12_345));
  });
});

describe("multi-epoch fine-tuning", () => {
  it("training loss steps down at an epoch boundary", () => {
    const { stage } = context("sft");
    const total = stage.curves[0]!.curves[0]!;
    const boundary = stage.run.totalSteps / (stage.run.epochs ?? 1);
    const before = curveAt(total, boundary - 60, stage, "heldout");
    const after = curveAt(total, boundary + 60, stage);
    expect(after).toBeLessThan(before * 0.88);
  });

  it("the best held-out checkpoint is not the last one", () => {
    const { stage } = context("sft");
    const every = stage.run.checkpointEvery;
    let best = every;
    for (let step = every; step <= stage.run.totalSteps; step += every) {
      if (validationAt(stage, step) < validationAt(stage, best)) best = step;
    }
    expect(best).toBeLessThan(stage.run.totalSteps);
    expect(best).toBeGreaterThan(stage.run.totalSteps / 3);
  });
});

describe("run log", () => {
  it("is ordered, uniquely identified and reaches back for filtered history", () => {
    for (const id of ALL) {
      const ctx = context(id);
      const source = frameSource(ctx);
      const tail = logTail(source, ctx.stage.run.openingStep, 60);
      expect(new Set(tail.map((line) => line.id)).size).toBe(tail.length);
      for (let index = 1; index < tail.length; index += 1) {
        expect(tail[index]!.runSeconds).toBeGreaterThanOrEqual(tail[index - 1]!.runSeconds);
      }
      const warnings = historyLines(source, ctx.stage.run.openingStep, "warnings", 30);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((line) => line.level !== "INFO")).toBe(true);
      const checkpoints = historyLines(source, ctx.stage.run.openingStep, "checkpoints", 5);
      expect(checkpoints.every((line) => line.source === "checkpoint")).toBe(true);
    }
  });
});

describe("replay speed", () => {
  it("changing speed moves nothing, then time passes faster", () => {
    const { stage } = context("sft");
    const control: RunControl = { status: "running", step: 1000, at: NOW, speed: 1 };
    const fast = withSpeed(control, stage.run, NOW + 10_000, 60);
    expect(fast.step).toBeCloseTo(stepAt(control, stage.run, NOW + 10_000), 9);
    const realTime =
      stepAt(control, stage.run, NOW + 20_000) - stepAt(control, stage.run, NOW + 10_000);
    const replayed = stepAt(fast, stage.run, NOW + 20_000) - fast.step;
    expect(replayed / realTime).toBeCloseTo(60, 6);
  });

  it("applies to every stage at once and survives a reload", () => {
    const session = setReplaySpeed(freshSession(NOW), 600, NOW + 5000);
    expect(replaySpeedOf(session)).toBe(600);
    for (const id of ALL) expect(session.controls[id].speed).toBe(600);
    const stored = new Map([[SESSION_KEY, JSON.stringify(session)]]);
    const reloaded = loadSession(NOW + 6000, { getItem: (key) => stored.get(key) ?? null });
    expect(replaySpeedOf(reloaded)).toBe(600);
  });

  it("rejects a speed it does not offer", () => {
    const session = freshSession(NOW);
    const tampered = JSON.stringify({
      ...session,
      controls: Object.fromEntries(
        Object.entries(session.controls).map(([id, control]) => [
          id,
          { ...control, speed: 1e6 },
        ]),
      ),
    });
    const loaded = loadSession(NOW, { getItem: () => tampered });
    expect(replaySpeedOf(loaded)).toBe(1);
    expect(REPLAY_SPEEDS[0]).toBe(1);
  });
});

describe("execution monitor and run console agree", () => {
  it("reads its diagnostics from the console's step frames", async () => {
    const { executionSnapshot } = await import("@/lib/modellab/execution");
    for (const id of ["pretraining", "sft"] as const) {
      const ctx = context(id);
      const step = ctx.stage.run.openingStep;
      const snapshot = executionSnapshot(ctx.stage, step, "nominal", ctx);
      const frame = frameAt(ctx, step);
      const data = frame.phases.find((phase) => phase.id === "data")!.seconds;
      expect(snapshot.wait).toBeCloseTo((data / frame.stepSeconds) * 100, 9);
      expect(snapshot.tertiary).toBe(frame.gradNorm);
    }
    const rl = context("rl");
    const snapshot = executionSnapshot(rl.stage, rl.stage.run.openingStep, "nominal", rl);
    expect(snapshot.tertiary).toBe(frameAt(rl, rl.stage.run.openingStep).rl!.pgClipfrac);
  });

  it("lights the evaluation phase only when an evaluation is dispatched", async () => {
    const { executionSnapshot } = await import("@/lib/modellab/execution");
    const { evalEvery } = await import("@/lib/modellab/evaluation");
    const ctx = context("sft");
    const every = evalEvery(ctx.stage);
    const boundary = every * 4;
    expect(executionSnapshot(ctx.stage, boundary, "nominal", ctx).phase).toBe(5);
    expect(
      executionSnapshot(ctx.stage, boundary + every / 2, "nominal", ctx).phase,
    ).toBeLessThan(5);
  });
});
