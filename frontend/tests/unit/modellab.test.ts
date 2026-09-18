import { describe, expect, it } from "vitest";

import { buildPlantRegister, fieldIdentity } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor, fieldReferencesFor } from "@/lib/investigation/model";
import { artifactFile } from "@/lib/modellab/artifacts";
import {
  checkpoints,
  curveAt,
  metricAt,
  openingControl,
  pause,
  resume,
  stepAt,
} from "@/lib/modellab/run";
import {
  alignmentMatrix,
  availability,
  buildSamples,
  corpusFacts,
  groundedAnswer,
  verifyAnswer,
} from "@/lib/modellab/samples";
import { STAGES } from "@/lib/modellab/stages";

/**
 * The model lab mixes live corpus facts with a simulated run. These tests pin the part that
 * must never drift into fabrication: tags agree with the photographs, the verifier catches an
 * invented tag, availability counts are derived rather than typed, and the run is a pure
 * function of its controls and the clock.
 */

const NOW = Date.UTC(2026, 8, 16, 15, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(
  drawing,
  adjacency,
  NOW,
  new Set(["tank67"]),
  fieldClassesFor(drawing),
);

describe("field evidence in the register", () => {
  it("names every photographed node consistently with its photograph", () => {
    for (const ref of fieldReferencesFor(drawing)) {
      const asset = register.assets.get(ref.nodeId)!;
      const identity = fieldIdentity(ref.fieldClass);
      if (asset.category === "exchanger") continue;
      expect(identity, ref.fieldClass).toBeDefined();
      if (identity!.kind === "instrument") {
        expect(asset.category).toBe("instrument");
        expect(asset.name).toBe(identity!.name);
        expect(asset.tag.startsWith(`${identity!.variable}${identity!.fn}-`)).toBe(true);
      } else {
        expect(asset.category).toBe(identity!.kind);
      }
    }
  });

  it("never makes a photographed handwheel valve part of a control loop", () => {
    expect(register.assets.get("valve38")?.category).toBe("hand-valve");
    expect(register.assets.get("valve38")?.loop).toBeUndefined();
  });

  it("applies no field evidence to a sheet the references were not registered against", () => {
    expect(fieldReferencesFor({ ...drawing, source: "Other/1.graphml" })).toEqual([]);
  });
});

describe("simulated run", () => {
  const stage = STAGES[0]!;

  it("advances at the stage throughput and freezes when paused", () => {
    const control = openingControl(stage.run, NOW);
    const later = NOW + 100_000;
    expect(stepAt(control, stage.run, later)).toBeCloseTo(
      stage.run.openingStep + 100 * stage.run.stepsPerSecond,
      6,
    );
    const paused = pause(control, stage.run, later);
    expect(stepAt(paused, stage.run, later + 3_600_000)).toBe(
      stepAt(control, stage.run, later),
    );
    const resumed = resume(paused, stage.run, later + 3_600_000);
    expect(resumed.status).toBe("running");
    expect(resumed.step).toBe(paused.step);
  });

  it("caps at the total and restarts from zero when resumed after completing", () => {
    const control = { status: "running" as const, step: stage.run.totalSteps - 1, at: NOW };
    expect(stepAt(control, stage.run, NOW + 1e9)).toBe(stage.run.totalSteps);
    expect(resume(control, stage.run, NOW + 1e9).step).toBe(0);
  });

  it("lowers losses and moves metrics toward their final values", () => {
    const loss = stage.curves[0]!.curves[0]!;
    expect(curveAt(loss, 90_000)).toBeLessThan(curveAt(loss, 1_000));
    for (const metric of stage.metrics) {
      expect(metricAt(metric, 0)).toBeCloseTo(metric.start, 6);
      expect(metricAt(metric, 1)).toBeCloseTo(metric.final, 6);
    }
  });

  it("writes checkpoints at the cadence and marks exactly one best", () => {
    const every = stage.run.checkpointEvery;
    const written = checkpoints(stage, every * 5, 100);
    expect(written.map((c) => c.step)).toEqual([5, 4, 3, 2, 1].map((n) => n * every));
    expect(written.filter((c) => c.best)).toHaveLength(1);
  });
});

describe("samples and verification", () => {
  it("builds five samples per stage from registered references only", () => {
    const references = new Set(fieldReferencesFor(drawing).map((ref) => ref.nodeId));
    for (const stage of STAGES) {
      const samples = buildSamples(stage, drawing, register, adjacency);
      expect(samples).toHaveLength(5);
      for (const sample of samples) expect(references.has(sample.nodeId)).toBe(true);
    }
  });

  it("passes a composed answer and fails one with an invented tag", () => {
    const sample = buildSamples(STAGES[2]!, drawing, register, adjacency)[0]!;
    const answer = groundedAnswer(sample, register, NOW);
    const good = verifyAnswer(answer.text, sample, drawing, register, adjacency, NOW);
    expect(good.pass).toBe(true);
    expect(good.fabricated).toEqual([]);

    const invented = answer.text.replace(sample.neighbours[0]!.tag, "XV-9999");
    const bad = verifyAnswer(invented, sample, drawing, register, adjacency, NOW);
    expect(bad.pass).toBe(false);
    expect(bad.fabricated).toContain("XV-9999");
  });

  it("fails a connection the graph does not have", () => {
    const sample = buildSamples(STAGES[2]!, drawing, register, adjacency)[0]!;
    const stranger = [...register.assets.values()].find(
      (asset) =>
        asset.nodeId !== sample.nodeId &&
        !sample.neighbours.some((n) => n.id === asset.nodeId) &&
        asset.category === "instrument",
    )!;
    const answer = groundedAnswer(sample, register, NOW);
    const wrong = answer.text.replace(
      /connected to [^.]*\./,
      `connected to ${stranger.tag}.`,
    );
    const result = verifyAnswer(wrong, sample, drawing, register, adjacency, NOW);
    expect(result.checks.find((c) => c.id === "topology")!.pass).toBe(false);
  });
});

describe("corpus facts", () => {
  const facts = corpusFacts(drawing, register, "demo", null, null, NOW);

  it("derives availability from the sheet, never from the contract", () => {
    const pre = availability("pretraining", facts);
    expect(pre.get("images")!.count).toBe(facts.fieldReferences);
    expect(pre.get("pid")!.basis).toMatch(/fixture/i);
    expect(availability("distillation", facts).get("dialogues")!.count).toBe(0);
  });

  it("keeps the alignment matrix symmetric with an empty diagonal", () => {
    const matrix = alignmentMatrix(facts);
    matrix.forEach((row, r) => {
      expect(row[r]).toBeNull();
      row.forEach((value, c) => expect(matrix[c]![r]).toBe(value));
    });
  });
});

describe("artifacts", () => {
  it("generates real configuration files and refuses to invent weights", () => {
    const stage = STAGES[3]!;
    const context = {
      stage,
      step: 40_000,
      progress: 0.8,
      generatedAt: "2026-09-16T15:00:00Z",
      sheet: "0.png",
      verifierPassRate: 1,
      samples: [],
    };
    const manifest = artifactFile(
      stage.outputs.find((o) => o.download === "manifest")!,
      context,
    )!;
    expect(manifest.body).toContain("No weights were trained");
    const serving = JSON.parse(
      artifactFile(
        stage.outputs.find((o) => o.download === "serving-config")!,
        context,
      )!.body,
    );
    expect(serving.provenance.run).toBe("simulated");
    expect(
      artifactFile(
        stage.outputs.find((o) => o.download === "weights")!,
        context,
      ),
    ).toBeUndefined();
  });
});
