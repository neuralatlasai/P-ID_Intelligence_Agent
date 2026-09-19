import { describe, expect, it } from "vitest";

import { batchRewards, objectiveShares } from "@/lib/modellab/ingestion";
import { curveAt } from "@/lib/modellab/run";
import { signalPolyline, trainingSignals } from "@/lib/modellab/signals";
import { stageById, STAGES } from "@/lib/modellab/stages";

describe("training signal projections", () => {
  it.each(["pretraining", "sft"] as const)(
    "%s contributions reconcile with the recipe",
    (id) => {
      const stage = stageById(id)!;
      const step = stage.run.openingStep;
      const recipe = objectiveShares(stage, step);
      const snapshot = trainingSignals(stage, step);
      expect(snapshot.total).toBeCloseTo(
        recipe.reduce((sum, row) => sum + row.weight * row.loss, 0),
        12,
      );
      for (const signal of snapshot.signals) {
        expect(signal.history.at(-1)).toBe(signal.value);
        expect(signal.contribution).toBeCloseTo(
          recipe.find((row) => row.key === signal.id)!.share * snapshot.total!,
          12,
        );
      }
    },
  );

  it("preserves negative reward penalties and reconciles the signed total", () => {
    const stage = stageById("rl")!;
    const step = stage.run.openingStep;
    const snapshot = trainingSignals(stage, step);
    const reward = batchRewards(stage, step, step / stage.run.totalSteps);
    expect(snapshot.signals.some((signal) => (signal.contribution ?? 0) < 0)).toBe(true);
    expect(snapshot.total).toBeCloseTo(
      reward.reduce((sum, row) => sum + row.value, 0),
      12,
    );
  });

  it("takes distillation weights from its total objective and reconciles with it", () => {
    const stage = stageById("distillation")!;
    const total = stage.curves[0]!.curves[0]!;
    const snapshot = trainingSignals(stage, 400);
    expect(snapshot.kind).toBe("loss");
    expect(snapshot.signals.map((signal) => signal.weight)).toEqual(
      total.sumOf!.map((term) => term.weight),
    );
    // The panel's total is the plotted total objective, not a second estimate of it.
    expect(snapshot.total).toBeCloseTo(curveAt(total, 400, stage), 12);
  });

  it("bounds histories to elapsed steps at zero, restart and completion", () => {
    for (const stage of STAGES) {
      for (const step of [0, -1, Number.NaN, 1, stage.run.totalSteps + 100]) {
        const snapshot = trainingSignals(stage, step);
        expect(snapshot.start).toBeGreaterThanOrEqual(0);
        expect(snapshot.end).toBeLessThanOrEqual(stage.run.totalSteps);
        expect(snapshot.start).toBeLessThanOrEqual(snapshot.end);
        for (const signal of snapshot.signals) {
          expect(signal.history).toHaveLength(32);
          expect(signal.history.every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it("renders flat and empty charts without division by zero", () => {
    expect(signalPolyline([])).toBe("");
    expect(signalPolyline([0, 0, 0])).toBe("4.00,27.00 100.00,27.00 196.00,27.00");
    expect(signalPolyline([1])).toBe("4.00,27.00");
  });
});
