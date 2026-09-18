import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import { buildSyntheticCandidates, executionSnapshot } from "@/lib/modellab/execution";
import { pause, resume, stepAt } from "@/lib/modellab/run";
import { buildSamples } from "@/lib/modellab/samples";
import { STAGES } from "@/lib/modellab/stages";

const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };

describe("execution replay invariants", () => {
  for (const stage of STAGES) {
    it(`${stage.id}: pause freezes diagnostics and resume advances the shared clock`, () => {
      const control = { status: "running" as const, step: 100, at: 1000 };
      const stopped = pause(control, stage.run, 6000);
      const snapshot = executionSnapshot(stage, stopped.step, "nominal");
      expect(
        executionSnapshot(stage, stepAt(stopped, stage.run, 60000), "nominal"),
      ).toEqual(snapshot);
      const restarted = resume(stopped, stage.run, 60000);
      expect(
        executionSnapshot(stage, stepAt(restarted, stage.run, 65000), "nominal").tick,
      ).toBeGreaterThan(snapshot.tick);
    });

    it(`${stage.id}: diagnostic injection cannot rewrite checkpoint results`, () => {
      const baseline = executionSnapshot(stage, stage.run.openingStep, "nominal");
      const stalled = executionSnapshot(stage, stage.run.openingStep, "input-stall");
      const regression = executionSnapshot(
        stage,
        stage.run.openingStep,
        "quality-regression",
      );
      expect(stalled.phase).toBe(0);
      expect(stalled.wait).toBeGreaterThan(69);
      expect(stalled.gates).toEqual(baseline.gates);
      expect(regression.gates).toEqual(baseline.gates);
      expect(baseline.trace).toHaveLength(24);
      expect(executionSnapshot(stage, Number.NaN, "nominal").tick).toBe(0);
    });
  }
});

describe("local synthetic record QC", () => {
  const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
  const register = buildPlantRegister(
    drawing,
    adjacency,
    0,
    new Set(),
    fieldClassesFor(drawing),
  );
  const samples = buildSamples(STAGES[0]!, drawing, register, adjacency);

  it("quarantines resolved records, rejects controls, and preserves source lineage", () => {
    expect(samples.length).toBeGreaterThan(1);
    const candidates = buildSyntheticCandidates(samples, drawing.source, 0);
    expect(candidates.some((item) => item.decision === "review")).toBe(true);
    expect(candidates.some((item) => item.decision === "duplicate")).toBe(true);
    expect(candidates.some((item) => item.decision === "invalid-reference")).toBe(true);
    const nodes = new Set(samples.map((item) => item.nodeId));
    for (const item of candidates) {
      expect(item.sourceId).toBe(drawing.source);
      expect(nodes.has(item.nodeId)).toBe(item.decision !== "invalid-reference");
    }
    expect(new Set(candidates.map((item) => item.id)).size).toBe(candidates.length);
  });

  it("bounds work, handles an empty corpus, and changes the next batch instruction", () => {
    expect(buildSyntheticCandidates([], "empty", 0)).toEqual([]);
    expect(
      buildSyntheticCandidates(Array(50).fill(samples[0]!), drawing.source, 0),
    ).toHaveLength(16);
    expect(buildSyntheticCandidates(samples, drawing.source, 1)[0]!.prompt).not.toBe(
      buildSyntheticCandidates(samples, drawing.source, 0)[0]!.prompt,
    );
  });
});
