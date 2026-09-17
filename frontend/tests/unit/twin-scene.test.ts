import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import {
  exchangerState,
  HEAT_EXCHANGER_SCENE,
  mapScene,
  MAX_FIELD_HOPS,
  nodeOf,
  resolveAnchor,
  SCENARIOS,
  scenarioTrend,
} from "@/lib/twin/scene";

/**
 * The twin joins three views through one mapping, so the properties worth pinning are the
 * ones that would silently break that join: boxes that fall off the photo, a detection
 * mapped to the wrong kind of symbol, two photo components claiming the same valve, and
 * physics that stops conserving energy.
 */

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const anchorId = resolveAnchor(HEAT_EXCHANGER_SCENE, drawing, adjacency)!;
const register = buildPlantRegister(drawing, adjacency, NOW, new Set([anchorId]));
const mapped = mapScene(HEAT_EXCHANGER_SCENE, anchorId, drawing, register, adjacency);
const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));

describe("HEAT_EXCHANGER_SCENE", () => {
  it("keeps every detection box inside the photograph, with unique ids", () => {
    const { detections, imageWidth, imageHeight } = HEAT_EXCHANGER_SCENE;
    for (const { box } of detections) {
      const [x0, y0, x1, y1] = box;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(imageWidth);
      expect(y1).toBeLessThanOrEqual(imageHeight);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    }
    expect(new Set(detections.map((d) => d.id)).size).toBe(detections.length);
  });
});

describe("mapScene", () => {
  it("anchors on the preferred vessel and gives it an exchanger identity", () => {
    expect(anchorId).toBe("tank67");
    const anchor = register.assets.get(anchorId)!;
    expect(anchor.category).toBe("exchanger");
    expect(anchor.tag).toMatch(/^E-\d{3}$/);
  });

  it("maps every detection on the OPEN100 sheet", () => {
    const unmapped = mapped.filter((m) => m.target.kind === "unmapped");
    expect(unmapped.map((m) => m.detection.id)).toEqual([]);
  });

  it("maps each detection to a symbol of the right kind", () => {
    for (const component of mapped) {
      const node = nodeOf(component);
      switch (component.detection.role) {
        case "anchor-body":
          expect(node).toBe(anchorId);
          break;
        case "valve":
          expect(kindOf.get(node!)).toBe("valve");
          break;
        case "local-indicator":
        case "transmitter":
          expect(kindOf.get(node!)).toBe("instrumentation");
          break;
        default:
          expect(component.target.kind).toBe("line");
      }
    }
  });

  it("prefers a like-for-like symbol and marks positional matches as low confidence", () => {
    const byId = new Map(mapped.map((m) => [m.detection.id, m]));
    const gauge = byId.get("D8")!;
    expect(gauge.target.kind === "asset" && gauge.target.name).toBe("Pressure Gauge");
    expect(gauge.confidence).toBe("medium");
    expect(byId.get("D1")!.confidence).toBe("high");
    for (const m of mapped) {
      if (m.target.kind === "asset" && m.detection.role === "valve") {
        const manual = register.assets.get(m.target.nodeId)!.category === "hand-valve";
        expect(m.confidence).toBe(manual ? "medium" : "low");
        if (!manual) expect(m.basis).toMatch(/another class/);
      }
    }
  });

  it("never lets two field components claim the same valve or instrument", () => {
    const claimed = mapped.filter((m) => m.target.kind === "asset").map((m) => nodeOf(m));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("records a checkable basis, with hop counts inside the skid bound", () => {
    for (const component of mapped) {
      expect(component.basis.length).toBeGreaterThan(0);
      const hops = /(\d+) graph hops/.exec(component.basis);
      if (hops) expect(Number(hops[1])).toBeLessThanOrEqual(MAX_FIELD_HOPS);
    }
  });

  it("reports unmapped honestly when the anchor has no register entry", () => {
    const empty = buildPlantRegister(drawing, adjacency, NOW);
    const bare = { ...empty, assets: new Map() };
    const result = mapScene(HEAT_EXCHANGER_SCENE, anchorId, drawing, bare, adjacency);
    expect(result.every((m) => m.target.kind === "unmapped")).toBe(true);
  });
});

describe("exchangerState", () => {
  it("balances energy: duty leaving the shell side arrives on the tube side", () => {
    for (const scenario of SCENARIOS) {
      for (const progress of [0, 0.3, 0.7, 1]) {
        const state = exchangerState(scenario.id, progress);
        const tubeGain = (state.tubeOutletC - 32) * 300;
        expect(tubeGain).toBeCloseTo(state.dutyKw, 3);
        expect(state.shellOutletC).toBeGreaterThanOrEqual(32);
        expect(state.shellOutletC).toBeLessThanOrEqual(240);
      }
    }
  });

  it("runs the clean exchanger inside the register's normal shell outlet band", () => {
    const { shellOutletC } = exchangerState("normal", 1);
    expect(shellOutletC).toBeGreaterThanOrEqual(118);
    expect(shellOutletC).toBeLessThanOrEqual(132);
  });

  it("moves each scenario's symptoms in the physically expected direction", () => {
    const clean = exchangerState("normal", 1);
    const fouled = exchangerState("fouling", 1);
    expect(fouled.dutyKw).toBeLessThan(clean.dutyKw);
    expect(fouled.shellOutletC).toBeGreaterThan(clean.shellOutletC);
    expect(fouled.shellDpBar).toBeGreaterThan(clean.shellDpBar);

    expect(exchangerState("tube-leak", 0.2).conductivity).toBe(clean.conductivity);
    expect(exchangerState("tube-leak", 1).conductivity).toBeGreaterThan(
      clean.conductivity * 3,
    );

    const closed = exchangerState("inlet-valve-closed", 1);
    expect(closed.dutyKw).toBeLessThan(clean.dutyKw * 0.2);
    expect(closed.shellDpBar).toBeLessThan(clean.shellDpBar * 0.05);
  });

  it("produces a deterministic 24-hour trend", () => {
    const first = scenarioTrend("fouling");
    expect(first).toHaveLength(96);
    expect(first.at(-1)!.hour).toBe(24);
    expect(scenarioTrend("fouling")).toEqual(first);
  });

  it("lists only failure detections that exist in the scene", () => {
    const ids = new Set(HEAT_EXCHANGER_SCENE.detections.map((d) => d.id));
    for (const scenario of SCENARIOS) {
      for (const id of scenario.affects) expect(ids.has(id)).toBe(true);
    }
  });
});
