import { describe, expect, it } from "vitest";

import { documentContent, loopWiring, workOrderDetail } from "@/lib/canvas/documents";
import { buildPlantRegister, type AssetRecord } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";

/**
 * A listed document is only worth opening if what it says agrees with the rest of the
 * workspace. These tests pin that agreement: the datasheet's line is the asset's line, the
 * loop diagram's final element is the loop partner, and both loop members draw the same loop.
 */

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(drawing, adjacency, NOW, new Set(["tank67"]));
const context = { register, sheet: "0.png", joined: [] };
const assets = [...register.assets.values()];
const first = (predicate: (asset: AssetRecord) => boolean) => assets.find(predicate)!;

const fieldsOf = (asset: AssetRecord, kind: string) => {
  const doc = asset.documents.find((d) => d.kind === kind)!;
  const content = documentContent(asset, doc, context);
  return new Map(
    content.blocks.flatMap((block) => (block.kind === "fields" ? block.rows : [])),
  );
};

describe("documentContent", () => {
  it("opens every document the register lists, with content", () => {
    for (const asset of assets) {
      for (const doc of asset.documents) {
        const content = documentContent(asset, doc, context);
        expect(content.blocks.length).toBeGreaterThan(0);
        expect(content.title).toContain(doc.kind === "P&ID" ? asset.tag : "");
      }
    }
  });

  it("puts the asset's own tag and line on its datasheet", () => {
    const transmitter = first((a) => a.category === "instrument" && Boolean(a.loop));
    const fields = fieldsOf(transmitter, "Datasheet");
    expect(fields.get("Tag number")).toBe(transmitter.tag);
    expect(fields.get("Line number")).toBe(
      register.lines.get(transmitter.lines[0] ?? "")?.number ?? "Not on a pipe run",
    );
    expect(fields.get("Alarm low / high")).toContain(
      String(transmitter.telemetry!.alarmHigh),
    );
  });

  it("names the loop partner as the final element, identically from both ends", () => {
    const transmitter = first((a) => a.category === "instrument" && Boolean(a.loop));
    const valve = first(
      (a) => a.category === "control-valve" && a.loop === transmitter.loop,
    );
    const fromTransmitter = loopWiring(transmitter, register);
    const fromValve = loopWiring(valve, register);

    expect(fromTransmitter.output?.tag).toBe(valve.tag);
    expect(fromTransmitter).toEqual(fromValve);
    expect(fromTransmitter.nodes[0]!.tag).toBe(transmitter.tag);
  });

  it("gives the exchanger a TEMA datasheet and an inspection report", () => {
    const exchanger = register.assets.get("tank67")!;
    expect(fieldsOf(exchanger, "Datasheet").get("TEMA type")).toBe("AES");
    const report = exchanger.documents.find((d) => d.kind === "Inspection report")!;
    const content = documentContent(exchanger, report, context);
    expect(
      content.blocks.some((b) => b.kind === "table" && b.heading.startsWith("Thickness")),
    ).toBe(true);
  });
});

describe("workOrderDetail", () => {
  it("lists tasks for the order's failure mode and documents the asset holds", () => {
    const asset = first((a) => a.workOrders.length > 0);
    const order = asset.workOrders[0]!;
    const detail = workOrderDetail(order, asset);
    expect(detail.failure.startsWith(order.failureCode)).toBe(true);
    expect(detail.tasks.length).toBeGreaterThan(0);
    for (const doc of detail.documents) expect(asset.documents).toContain(doc);
  });
});
