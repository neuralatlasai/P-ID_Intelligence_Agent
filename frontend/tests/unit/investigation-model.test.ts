import { describe, expect, it } from "vitest";

import {
  createDemoFusionManifest,
  createInvestigationModel,
  parseFusionManifest,
} from "@/lib/investigation/model";
import { drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";

const DRAWING: CanvasDrawing = {
  source: "unit/PID-01.graphml",
  imagePath: "unit/PID-01.png",
  width: 1000,
  height: 600,
  directed: false,
  nodes: [
    { id: "valve1", kind: "valve", x: 100, y: 100, width: 20, height: 20 },
    { id: "tank1", kind: "tank", x: 200, y: 100, width: 80, height: 100 },
    { id: "pump1", kind: "pump", x: 300, y: 100, width: 40, height: 40 },
  ],
  edges: [
    { source: "valve1", target: "tank1", style: "solid" },
    { source: "tank1", target: "pump1", style: "solid" },
  ],
};

describe("createInvestigationModel", () => {
  it("maps generated and simulated information to a real source node", () => {
    const model = createInvestigationModel(DRAWING);

    expect(model.asset.id).toBe("tank1");
    expect(model.neighbours).toEqual(["valve1", "pump1"]);
    expect(model.incidentEdges).toBe(2);
    expect(model.sources.map((source) => source.provenance)).toEqual([
      "corpus",
      "corpus",
      "generated",
      "simulation",
    ]);
  });

  it("creates twelve one-to-one annotation records for the default corpus drawing", () => {
    const drawing = {
      ...fixture,
      imagePath: "PID2Graph OPEN100/0.png",
    };
    const model = createInvestigationModel(drawing, createDemoFusionManifest(drawing));

    expect(model.fusionAssets).toHaveLength(12);
    expect(model.fusionAssets.map((asset) => asset.annotationId)).toEqual([
      "ANN-001",
      "ANN-002",
      "ANN-003",
      "ANN-004",
      "ANN-005",
      "ANN-006",
      "ANN-007",
      "ANN-008",
      "ANN-009",
      "ANN-010",
      "ANN-011",
      "ANN-012",
    ]);
    expect(model.fusionAssets.map((asset) => asset.node.id)).toEqual([
      "tank67",
      "tank70",
      "valve43",
      "valve38",
      "instrumentation14",
      "instrumentation15",
      "instrumentation22",
      "instrumentation25",
      "instrumentation31",
      "instrumentation42",
      "instrumentation60",
      "instrumentation61",
    ]);
    expect(
      model.fusionAssets.every(
        (asset) =>
          asset.provenance === "generated" &&
          asset.mappingStatus === "verified-node-and-class" &&
          asset.incidentEdges >= 0,
      ),
    ).toBe(true);
  });

  it("rejects a manifest whose live coordinate was changed", () => {
    const drawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
    const manifest = createDemoFusionManifest(drawing);
    const records = manifest.records.map((record, index) =>
      index === 0 ? { ...record, node: { ...record.node, x: record.node.x + 1 } } : record,
    );

    expect(parseFusionManifest({ ...manifest, records }, drawing)).toBeUndefined();
  });

  it("rejects duplicate annotation and source-node identities", () => {
    const drawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
    const manifest = createDemoFusionManifest(drawing);
    const records = manifest.records.map((record, index) =>
      index === 1
        ? {
            ...record,
            annotationId: manifest.records[0]!.annotationId,
            node: manifest.records[0]!.node,
          }
        : record,
    );

    expect(parseFusionManifest({ ...manifest, records }, drawing)).toBeUndefined();
  });
});
