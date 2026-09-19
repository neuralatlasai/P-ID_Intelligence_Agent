import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildModel, SCENE_MODELS } from "@/components/twin/models";
import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor, fieldReferencesFor } from "@/lib/investigation/model";
import {
  CONTROL_VALVE_SCENE,
  FLOWMETER_SCENE,
  KNOCKOUT_DRUM_SCENE,
  RADAR_LEVEL_SCENE,
  TEMPERATURE_SCENE,
  TWIN_SCENES,
} from "@/lib/twin/field-scenes";
import {
  equalPercentageKv,
  gateOpenFraction,
  laggedReadingC,
  liquidFlowM3h,
  loopCurrentMa,
  magmeterFlowM3h,
  pt100Ohms,
  radarState,
  vesselState,
  vesselVolume,
  type VesselBasis,
} from "@/lib/twin/process";
import { mapScene, resolveAnchor, type FieldScene } from "@/lib/twin/scene";

/**
 * Every scene the twin offers is held to the same invariants, because each one joins the
 * same three views through the same ids: a box off the photo, a duplicated id or a 3D part
 * with no box would each break the join silently, and a mapping to a symbol the sheet does
 * not have would put a false claim in front of a reviewer.
 */

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
// The register exactly as the workspace builds it: the exchanger scene's anchor confirmed,
// and the fusion references' device classes applied.
const register = buildPlantRegister(
  drawing,
  adjacency,
  NOW,
  new Set(["tank67"]),
  fieldClassesFor(drawing),
);
const nodeIds = new Set(drawing.nodes.map((node) => node.id));
const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));

const mapped = (scene: FieldScene) => {
  const anchor = resolveAnchor(scene, drawing, adjacency);
  return anchor ? mapScene(scene, anchor, drawing, register, adjacency) : [];
};
const byId = (scene: FieldScene) => new Map(mapped(scene).map((m) => [m.detection.id, m]));

describe("the scene catalogue", () => {
  it("offers the exchanger and at least six field-reference scenes, with unique ids", () => {
    expect(TWIN_SCENES.length).toBeGreaterThanOrEqual(7);
    expect(TWIN_SCENES[0]!.id).toBe("SCN-EXCHANGER");
    expect(new Set(TWIN_SCENES.map((s) => s.id)).size).toBe(TWIN_SCENES.length);
  });

  it("labels every photograph as generated", () => {
    for (const scene of TWIN_SCENES) expect(scene.provenance).toBe("generated");
  });

  it("never anchors two scenes on the same symbol", () => {
    const anchors = TWIN_SCENES.map((scene) => resolveAnchor(scene, drawing, adjacency));
    expect(anchors.every((anchor) => anchor !== undefined)).toBe(true);
    expect(new Set(anchors).size).toBe(anchors.length);
    // Nor could they on any sheet: no node is preferred by two scenes.
    const preferred = TWIN_SCENES.flatMap((scene) => scene.preferredAnchors);
    expect(new Set(preferred).size).toBe(preferred.length);
  });

  it("gives every filmstrip card a distinct tag", () => {
    // The strip shows the anchor's tag, falling back to the node id — as DigitalTwinView does.
    const tags = TWIN_SCENES.map((scene) => {
      const anchor = resolveAnchor(scene, drawing, adjacency)!;
      return register.assets.get(anchor)?.tag ?? anchor;
    });
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("anchors each field-reference scene on the node its photograph is registered to", () => {
    const references = fieldReferencesFor(drawing);
    for (const scene of TWIN_SCENES.filter((s) => s.anchorRule === "registered")) {
      const anchor = resolveAnchor(scene, drawing, adjacency);
      expect(anchor).toBe(scene.preferredAnchors[0]);
      expect(
        references.some((r) => r.nodeId === anchor && r.generatedImagePath === scene.image),
      ).toBe(true);
    }
  });

  it("finds no anchor for a registered scene on a sheet without the registration", () => {
    const other: CanvasDrawing = { ...drawing, source: "Dataset PID/10.graphml" };
    for (const scene of TWIN_SCENES.filter((s) => s.anchorRule === "registered")) {
      expect(resolveAnchor(scene, other, adjacency)).toBeUndefined();
    }
  });
});

describe.each(TWIN_SCENES.map((scene) => [scene.id, scene] as const))("%s", (_, scene) => {
  it("has unique detection ids and at least three detections", () => {
    const ids = scene.detections.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every box inside the photograph and non-degenerate", () => {
    for (const { box } of scene.detections) {
      const [x0, y0, x1, y1] = box;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(scene.imageWidth);
      expect(y1).toBeLessThanOrEqual(scene.imageHeight);
      // Big enough to see and to click on a phone: at least 24 px each way.
      expect(x1 - x0).toBeGreaterThanOrEqual(24);
      expect(y1 - y0).toBeGreaterThanOrEqual(24);
    }
  });

  it("builds a 3D part for every detection, and no part without one", () => {
    const spec = SCENE_MODELS[scene.id];
    expect(spec).toBeDefined();
    const detectionIds = scene.detections.map((d) => d.id).sort();
    expect(Object.keys(spec!.parts).sort()).toEqual(detectionIds);

    const { root, parts } = buildModel(spec!, () => new THREE.MeshBasicMaterial());
    for (const [id, group] of parts) {
      let meshes = 0;
      group.traverse((child) => {
        expect(child.userData.detection).toBe(id);
        if (child instanceof THREE.Mesh) meshes += 1;
      });
      expect(meshes).toBeGreaterThan(0);
    }
    // Context geometry is never pickable: nothing outside the parts carries an id.
    root.traverse((child) => {
      if (child.userData.detection !== undefined)
        expect(detectionIds).toContain(child.userData.detection);
    });
  });

  it("maps every detection to a node on the drawing, a real run, or explicitly nothing", () => {
    const result = mapped(scene);
    expect(result).toHaveLength(scene.detections.length);
    for (const m of result) {
      switch (m.target.kind) {
        case "asset":
        case "part":
          expect(nodeIds.has(m.target.nodeId)).toBe(true);
          expect(register.assets.get(m.target.nodeId)?.tag).toBe(m.target.tag);
          break;
        case "line":
          expect(register.lines.has(m.target.lineId)).toBe(true);
          break;
        case "unmapped":
          expect(m.target.reason.length).toBeGreaterThan(20);
          expect(m.confidence).toBe("low");
          break;
      }
      expect(m.basis.length).toBeGreaterThan(0);
    }
  });

  it("maps each field role onto a symbol of the right class", () => {
    const anchor = resolveAnchor(scene, drawing, adjacency);
    for (const m of mapped(scene)) {
      if (m.target.kind === "unmapped") continue;
      const node = m.target.kind === "line" ? undefined : m.target.nodeId;
      switch (m.detection.role) {
        case "anchor-body":
          expect(node).toBe(anchor);
          break;
        case "inlet-side":
        case "outlet-side":
          expect(m.target.kind).toBe("line");
          break;
        case "valve":
        case "relief-valve":
          expect(kindOf.get(node!)).toBe("valve");
          break;
        case "host-vessel":
          expect(kindOf.get(node!)).toBe("tank");
          break;
        default:
          expect(kindOf.get(node!)).toBe("instrumentation");
      }
    }
  });

  it("never shows heat-exchanger physics for anything but an exchanger", () => {
    const isExchanger = scene.expectedCategories.includes("exchanger");
    expect(scene.process.kind === "exchanger").toBe(isExchanger);
  });
});

describe("field-reference mappings", () => {
  it("maps the temperature transmitter's head onto its own symbol and its well onto the line", () => {
    const result = byId(TEMPERATURE_SCENE);
    const head = result.get("T1")!;
    expect(head.target.kind === "part" && head.target.name).toBe("Temperature Transmitter");
    expect(head.confidence).toBe("high");
    expect(result.get("T6")!.target.kind).toBe("line");
  });

  it("gives the knock-out drum body a high-confidence vessel identity", () => {
    const shell = byId(KNOCKOUT_DRUM_SCENE).get("K1")!;
    expect(shell.target.kind === "part" && shell.target.name).toBe("Knock-out Drum");
    expect(shell.confidence).toBe("high");
  });

  it("will not substitute another valve class for a relief valve", () => {
    const relief = byId(KNOCKOUT_DRUM_SCENE).get("K4")!;
    if (relief.target.kind === "unmapped") {
      expect(relief.target.reason).toMatch(/not substituted/);
    } else {
      expect(relief.target.kind).toBe("asset");
      if (relief.target.kind === "asset")
        expect(register.assets.get(relief.target.nodeId)?.category).toBe("safety-valve");
    }
  });

  it("anchors the control valve on a control valve and its pipe on real runs", () => {
    const result = byId(CONTROL_VALVE_SCENE);
    const body = result.get("C1")!;
    expect(body.target.kind === "part" && body.target.tag).toMatch(/CV-/);
    const left = result.get("C5")!;
    const right = result.get("C6")!;
    if (left.target.kind !== "line" || right.target.kind !== "line")
      throw new Error("both line flanges should map to runs");
    expect(left.target.lineId).not.toBe(right.target.lineId);
  });

  it("puts both flowmeter flanges on its one run, saying so", () => {
    for (const id of ["F5", "F6"]) {
      const flange = byId(FLOWMETER_SCENE).get(id)!;
      expect(flange.target.kind).toBe("line");
      expect(flange.basis).toMatch(/Only run/);
    }
  });

  it("leaves the radar transmitter's vessel unmapped, because its symbol is isolated", () => {
    const result = byId(RADAR_LEVEL_SCENE);
    expect(adjacency.get("instrumentation42") ?? []).toHaveLength(0);
    for (const id of ["L1", "L2"]) {
      const part = result.get(id)!;
      expect(part.target.kind).toBe("unmapped");
      if (part.target.kind === "unmapped")
        expect(part.target.reason).toMatch(/no connection/);
    }
    expect(result.get("L6")!.target.kind).toBe("part");
  });
});

describe("process relations", () => {
  const basis: VesselBasis = {
    idM: 2,
    tangentM: 4.8,
    spanM: 3.6,
    densityKgM3: 882,
    operatingBarg: 10,
    outflowM3h: 12,
    alarmLowPct: 15,
    alarmHighPct: 85,
    fluid: "test",
  };

  it("integrates a 2:1 head to πD³/24 and a full vessel to heads plus shell", () => {
    const head = (Math.PI * 2 ** 3) / 24;
    expect(vesselVolume(basis, 0.5)).toBeCloseTo(head, 9);
    expect(vesselVolume(basis, 0.5 + 4.8 + 0.5)).toBeCloseTo(2 * head + Math.PI * 4.8, 9);
    let last = -1;
    for (let z = 0; z <= 5.8; z += 0.1) {
      const v = vesselVolume(basis, z);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });

  it("adds liquid head to the vapour pressure and counts down to the right alarm", () => {
    const state = vesselState(basis, 50, 3);
    expect(state.bottomBarg).toBeCloseTo(10 + (882 * 9.80665 * 1.8) / 1e5, 9);
    expect(state.toward).toBe("high");
    const target = vesselVolume(basis, 0.85 * 3.6);
    expect(state.toAlarmMin).toBeCloseTo(((target - state.holdupM3) / 3) * 60, 9);
    expect(vesselState(basis, 10, -3).toAlarmMin).toBeUndefined();
  });

  it("follows the equal-percentage law between Kvs/R and Kvs", () => {
    const valve = { kvs: 250, rangeability: 50, dpBar: 2, sg: 1 };
    expect(equalPercentageKv(valve, 1)).toBeCloseTo(250, 9);
    expect(equalPercentageKv(valve, 0)).toBe(0);
    expect(equalPercentageKv(valve, 0.5)).toBeCloseTo(250 / Math.sqrt(50), 9);
    // Equal steps of travel give equal ratios of Kv.
    const r1 = equalPercentageKv(valve, 0.6) / equalPercentageKv(valve, 0.5);
    const r2 = equalPercentageKv(valve, 0.9) / equalPercentageKv(valve, 0.8);
    expect(r1).toBeCloseTo(r2, 9);
    expect(liquidFlowM3h(100, 4, 1)).toBeCloseTo(200, 9);
  });

  it("opens a round port by circular-segment area", () => {
    expect(gateOpenFraction(0)).toBe(0);
    expect(gateOpenFraction(1)).toBe(1);
    expect(gateOpenFraction(0.5)).toBeCloseTo(0.5, 9);
    expect(gateOpenFraction(0.25)).toBeLessThan(0.25);
    expect(gateOpenFraction(0.75)).toBeGreaterThan(0.75);
  });

  it("converts velocity to flow through the bore, and flow to loop current", () => {
    const meter = { boreM: 0.0779, urvM3h: 100, velocityMin: 0.3, velocityMax: 10 };
    expect(magmeterFlowM3h(meter, 1)).toBeCloseTo(((Math.PI * 0.0779 ** 2) / 4) * 3600, 9);
    expect(loopCurrentMa(50, 0, 100)).toBeCloseTo(12, 9);
    expect(loopCurrentMa(200, 0, 100)).toBe(20.5);
  });

  it("reads a Pt100 to IEC 60751 and lags a step by one time constant to 63 %", () => {
    expect(pt100Ohms(0)).toBeCloseTo(100, 9);
    expect(pt100Ohms(100)).toBeCloseTo(138.5055, 3);
    const basis = { lrvC: 0, urvC: 300, tauS: 30, initialC: 200 };
    expect(laggedReadingC(basis, 250, 0)).toBeCloseTo(200, 9);
    expect(laggedReadingC(basis, 250, 30)).toBeCloseTo(200 + 50 * (1 - Math.exp(-1)), 9);
    expect(laggedReadingC(basis, 250, 1e6)).toBeCloseTo(250, 6);
  });

  it("times the radar echo at 2d/c and refuses a reading inside the blocking distance", () => {
    const radar = { referenceM: 10, blockingM: 0.4, lrvM: 0.5, urvM: 9 };
    const mid = radarState(radar, 7);
    expect(mid.distanceM).toBeCloseTo(3, 9);
    expect(mid.roundTripNs).toBeCloseTo((6 / 299_792_458) * 1e9, 9);
    expect(mid.readingM).toBeCloseTo(7, 9);
    const blocked = radarState(radar, 9.8);
    expect(blocked.readingM).toBeUndefined();
    expect(blocked.currentMa).toBeUndefined();
  });
});
