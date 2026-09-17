import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import { architectureSpec } from "@/lib/modellab/architecture";
import { DEFAULT_CONFIG, runProfile } from "@/lib/modellab/config";
import { availability, corpusFacts } from "@/lib/modellab/samples";
import { STAGES } from "@/lib/modellab/stages";

/**
 * The architecture figure is read by engineers as a specification. These tests pin what would
 * make it wrong: a reference path through a box that is not drawn, a source shown as connected
 * when the corpus has none of it, a disabled encoder drawn solid, and ids that collide.
 */

const NOW = Date.UTC(2026, 8, 17, 16, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(drawing, adjacency, NOW, new Set(["tank67"]), fieldClassesFor(drawing));
const facts = corpusFacts(drawing, register, "demo", null, null, NOW);

describe("architecture spec", () => {
  for (const stage of STAGES) {
    const config = DEFAULT_CONFIG[stage.id];
    const spec = architectureSpec(stage, config, runProfile(stage.id, config), facts);
    const boxes = [
      ...spec.sources,
      ...spec.model.flat(),
      ...spec.heads,
      spec.aggregate,
      ...spec.chain,
    ];

    it(`${stage.id}: every traced box is drawn, and ids are unique`, () => {
      const ids = boxes.map((box) => box.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of spec.trace) expect(ids, id).toContain(id);
      // The path visits a source, the model, a head, the aggregate and the whole chain.
      expect(spec.trace.some((id) => spec.sources.some((box) => box.id === id))).toBe(true);
      expect(spec.trace.some((id) => spec.heads.some((box) => box.id === id))).toBe(true);
      expect(spec.trace).toContain(spec.aggregate.id);
      for (const box of spec.chain) expect(spec.trace).toContain(box.id);
    });

    it(`${stage.id}: a source is dashed exactly when the corpus holds none of it`, () => {
      if (stage.contract.length === 0) return;
      const available = availability(stage.id, facts);
      for (const row of stage.contract) {
        const box = spec.sources.find((item) => item.id === `src-${row.id}`)!;
        expect(Boolean(box.absent), row.id).toBe((available.get(row.id)?.count ?? 0) === 0);
      }
    });

    it(`${stage.id}: ends with a checkpoint and names the applied backbone`, () => {
      expect(spec.chain.at(-1)?.symbol).toBe("checkpoint");
      expect(`${spec.modelDetail} ${spec.model.flat().map((box) => box.detail).join(" ")}`).toContain(
        runProfile(stage.id, config).backbone.name.slice(0, 10),
      );
    });
  }

  it("draws a disabled graph encoder dashed", () => {
    const stage = STAGES.find((item) => item.id === "sft")!;
    const config = { ...DEFAULT_CONFIG.sft, graph: "none" };
    const spec = architectureSpec(stage, config, runProfile("sft", config), facts);
    const graph = spec.model.flat().find((box) => box.id === "enc-graph")!;
    expect(graph.absent).toBe(true);
    expect(graph.detail).toMatch(/disabled/);
  });
});
