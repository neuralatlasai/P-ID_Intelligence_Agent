import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, runProfile } from "@/lib/modellab/config";
import { lastEvalStep, metricAtEval } from "@/lib/modellab/evaluation";
import { checkpointLifecycle, evalScoreAt, runEvents } from "@/lib/modellab/events";
import { epochPosition } from "@/lib/modellab/ingestion";
import { checkpoints, curveAt } from "@/lib/modellab/run";
import { STAGES, stageById, type Stage, type StageId } from "@/lib/modellab/stages";

/**
 * An expert reads a training dashboard by cross-checking it: the eval in the log against the
 * metrics table, the checkpoint in the log against the checkpoint table, the KL in the
 * progress panel against the curve. These tests pin that every such pair is read from one
 * source, so no two cards on a page can disagree.
 */

const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);

function effective(id: StageId): Stage {
  const base = stageById(id)!;
  const rate = runProfile(id, DEFAULT_CONFIG[id]).stepsPerSecond;
  return { ...base, run: { ...base.run, stepsPerSecond: rate } };
}

describe("curves", () => {
  it("plots a series with the same values in every tab that shows it", () => {
    for (const stage of STAGES) {
      const byKey = new Map<string, string>();
      for (const curve of stage.curves.flatMap((tab) => tab.curves)) {
        const signature = JSON.stringify([curve.start, curve.end, curve.tau, curve.noise]);
        const seen = byKey.get(curve.key);
        if (seen) expect(signature, `${stage.id}:${curve.key}`).toBe(seen);
        byKey.set(curve.key, signature);
      }
    }
  });
});

describe("epochs", () => {
  it("plans about three passes over each fine-tuning contract at the default batch", () => {
    for (const id of ["sft", "distillation"] as const) {
      const stage = stageById(id)!;
      const { datasetSize } = epochPosition(stage, 0, DEFAULT_CONFIG[id].globalBatch);
      const planned = (stage.run.totalSteps * DEFAULT_CONFIG[id].globalBatch) / datasetSize;
      expect(planned, id).toBeGreaterThan(2.9);
      expect(planned, id).toBeLessThan(3.1);
      expect(stage.run.epochs).toBe(3);
    }
  });
});

describe("evaluations", () => {
  it("logs exactly the score the metrics table shows for that evaluation", () => {
    for (const id of ["pretraining", "sft", "rl", "distillation"] as const) {
      const stage = effective(id);
      const step = stage.run.openingStep;
      const evals = runEvents(stage, step, NOW, stage.run.stepsPerSecond, 400).filter(
        (event) => event.kind === "eval",
      );
      expect(evals.length, id).toBeGreaterThan(0);
      const newest = evals[0]!;
      const metric = stage.metrics[0]!;
      // The newest logged evaluation is the one the table currently reports.
      expect(newest.message).toContain(
        metricAtEval(metric, stage, step).toFixed(metric.digits),
      );
      expect(newest.message).toContain(
        `step-${String(lastEvalStep(stage, step)).padStart(6, "0")}`,
      );
    }
  });
});

describe("checkpoints", () => {
  it("marks the highest held-out reward best in stage 3 and the lowest loss elsewhere", () => {
    for (const id of ["pretraining", "rl"] as const) {
      const stage = effective(id);
      const all = checkpoints(stage, stage.run.openingStep, Number.MAX_SAFE_INTEGER);
      const best = all.find((item) => item.best)!;
      const values = all.map((item) => item.valLoss);
      expect(best.valLoss).toBe(id === "rl" ? Math.max(...values) : Math.min(...values));
    }
  });

  it("never logs a checkpoint as serialized while the table still shows it serializing", () => {
    for (const id of ["pretraining", "sft", "rl", "distillation"] as const) {
      const stage = effective(id);
      const rate = stage.run.stepsPerSecond;
      for (const seconds of [5, 60, 74, 76, 200, 299, 301]) {
        const step = stage.run.checkpointEvery * 6 + seconds * rate;
        const writing = checkpointLifecycle(stage, step, rate, NOW).writing;
        const logged = runEvents(stage, step, NOW, rate, 50).some(
          (event) =>
            event.kind === "checkpoint-written" &&
            event.id === `ckpt-write:${stage.run.checkpointEvery * 6}`,
        );
        if (writing?.phase === "serialize")
          expect(logged, `${id} @${seconds}s`).toBe(false);
        else expect(logged, `${id} @${seconds}s`).toBe(true);
      }
    }
  });

  it("scores evaluated checkpoints with the harness's number for that step", () => {
    const stage = effective("distillation");
    const life = checkpointLifecycle(
      stage,
      stage.run.openingStep,
      stage.run.stepsPerSecond,
      NOW,
    );
    for (const record of life.records) {
      if (record.evalScore !== undefined)
        expect(record.evalScore).toBe(evalScoreAt(stage, record.step));
    }
  });
});

describe("stage 3 KL", () => {
  it("reads the policy KL from one series, on the order of its 0.02 target", () => {
    const stage = effective("rl");
    const kls = stage.curves
      .flatMap((tab) => tab.curves)
      .filter((curve) => curve.key === "kl");
    const values = kls.map((curve) => curveAt(curve, stage.run.openingStep));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(0.01);
    expect(values[0]).toBeLessThan(0.03);
  });
});
