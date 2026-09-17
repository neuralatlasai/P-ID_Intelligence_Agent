import { describe, expect, it } from "vitest";
import {
  scenarioProfile,
  scenarioValue,
  scenarioWindow,
  traceEquipment,
} from "@/lib/investigation/engineering";
import type { CanvasDrawing } from "@/lib/canvas/model";

describe("engineering response and topology", () => {
  it("preserves initial conditions and approaches the imposed input without overshoot", () => {
    const profile = scenarioProfile("tank67");
    expect(scenarioValue("tank67", 0, 20)).toBe(profile.baseline);
    expect(scenarioValue("tank67", 10, 20)).toBe(profile.baseline);
    expect(scenarioValue("tank67", 3600, 20)).toBeCloseTo(profile.baseline + 20);
    expect(scenarioValue("tank67", 3600, -20)).toBeCloseTo(profile.baseline - 20);
    expect(scenarioValue("tank67", 100, Number.NaN)).toBe(profile.baseline);
    expect(scenarioWindow("tank67", 3600, 20)).toHaveLength(61);
  });
  it("traces through connectors and stops at first equipment, including cycles", () => {
    const drawing: CanvasDrawing = {
      source: "unit",
      imagePath: "unit.png",
      width: 100,
      height: 100,
      directed: false,
      nodes: ["tank", "connector", "crossing", "valve", "pump"].map((kind) => ({
        id: kind,
        kind,
        x: 10,
        y: 10,
        width: 5,
        height: 5,
      })),
      edges: [
        { source: "tank", target: "connector" },
        { source: "connector", target: "crossing" },
        { source: "crossing", target: "tank" },
        { source: "crossing", target: "valve" },
        { source: "valve", target: "pump" },
      ],
    };
    expect(traceEquipment(drawing, "tank")).toEqual([
      { id: "valve", kind: "valve", path: ["tank", "crossing", "valve"] },
    ]);
    expect(traceEquipment({ ...drawing, directed: true }, "pump")).toEqual([]);
  });
});
