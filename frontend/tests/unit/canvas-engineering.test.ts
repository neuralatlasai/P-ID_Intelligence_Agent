import { describe, expect, it } from "vitest";

import {
  buildPlantRegister,
  FAILURE_MODES,
  hashString,
  simulateTrend,
  TREND_WINDOWS,
} from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";

/**
 * The register assigns professional identities to symbols the source leaves anonymous.
 * Because those identities are simulated, the properties worth pinning are the ones that
 * keep them from being misleading: every tag is unique, the same sheet always yields the
 * same tags, loops are internally consistent, and nothing claims to be real that is not.
 */

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const register = () =>
  buildPlantRegister(
    drawing,
    buildAdjacency(drawing.nodes, drawing.edges, drawing.directed),
    NOW,
  );

describe("buildPlantRegister", () => {
  it("gives every equipment symbol exactly one unique tag", () => {
    const { assets, nodeByTag } = register();
    const equipment = drawing.nodes.filter((n) =>
      ["valve", "instrumentation", "tank", "pump", "inlet/outlet"].includes(n.kind),
    );
    const tags = [...assets.values()].map((asset) => asset.tag);

    expect(assets.size).toBe(equipment.length);
    expect(new Set(tags).size).toBe(tags.length);
    expect(nodeByTag.size).toBe(tags.length);
  });

  it("is deterministic: the same sheet yields the same register", () => {
    const first = register();
    const second = register();

    expect([...first.assets.values()].map((a) => a.tag)).toEqual(
      [...second.assets.values()].map((a) => a.tag),
    );
    expect([...first.lines.values()].map((l) => l.number)).toEqual(
      [...second.lines.values()].map((l) => l.number),
    );
  });

  it("uses ISA-5.1 shaped tags", () => {
    for (const asset of register().assets.values()) {
      expect(asset.tag).toMatch(/^[A-Z]{1,4}-\d{2,4}[A-Z]?$/);
    }
  });

  it("names the OPEN100 main steam sheet for what its title block says it is", () => {
    const { service, system } = register();

    expect(service.code).toBe("MS");
    expect(system).toBe("Main Steam System");
  });

  it("makes a control valve and its transmitter share a loop and a variable", () => {
    const { assets } = register();
    const valves = [...assets.values()].filter((a) => a.category === "control-valve");

    expect(valves.length).toBeGreaterThan(0);
    for (const valve of valves) {
      const partner = [...assets.values()].find(
        (a) => a.category === "instrument" && a.loop === valve.loop,
      );
      expect(partner, `no transmitter for ${valve.tag}`).toBeDefined();
      // FCV-1003 pairs with FIT-1003: same first letter, same loop number.
      expect(valve.tag.startsWith(partner!.variable!)).toBe(true);
      expect(valve.tag.endsWith(partner!.loop!)).toBe(true);
    }
  });

  it("formats line numbers as size-service-sequence-class", () => {
    for (const line of register().lines.values()) {
      expect(line.number).toMatch(/^\d{1,2}"-[A-Z]{2,3}-\d{4}-[A-Z]\d[A-Z]$/);
    }
  });

  it("puts every line's assets on real topology", () => {
    const { lines } = register();
    const ids = new Set(drawing.nodes.map((n) => n.id));

    for (const line of lines.values()) {
      for (const member of [...line.members, ...line.assets]) {
        expect(ids.has(member)).toBe(true);
      }
    }
  });

  it("uses only ISO 14224 failure-mode codes", () => {
    const known = new Set(Object.keys(FAILURE_MODES));
    for (const asset of register().assets.values()) {
      for (const mode of asset.failureModes) expect(known.has(mode.code)).toBe(true);
    }
  });

  it("marks every simulated record, and only the drawing file as real", () => {
    for (const asset of register().assets.values()) {
      expect(asset.simulated).toBe(true);
      const real = asset.documents.filter((document) => !document.simulated);
      expect(real).toHaveLength(1);
      expect(real[0]!.kind).toBe("P&ID");
    }
  });
});

describe("simulateTrend", () => {
  const spec = {
    measurement: "Pressure",
    unit: "barg",
    normal: [8, 12] as const,
    alarmLow: 5,
    alarmHigh: 15,
    seed: hashString("PT-1014"),
  };

  it("returns the window's resolution, oldest first", () => {
    for (const window of Object.keys(TREND_WINDOWS) as (keyof typeof TREND_WINDOWS)[]) {
      const series = simulateTrend(spec, window, NOW);
      expect(series).toHaveLength(TREND_WINDOWS[window].points);
      expect(series[0]!.t).toBeLessThan(series.at(-1)!.t);
    }
  });

  it("draws the same history for the same tag", () => {
    expect(simulateTrend(spec, "1D", NOW)).toEqual(simulateTrend(spec, "1D", NOW));
  });

  it("stays near the normal band, as a regulated variable should", () => {
    const values = simulateTrend(spec, "1W", NOW).map((p) => p.v);
    const inside = values.filter((v) => v > spec.alarmLow && v < spec.alarmHigh);
    expect(inside.length / values.length).toBeGreaterThan(0.95);
  });
});
