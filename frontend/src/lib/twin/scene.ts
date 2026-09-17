/**
 * Field image, 3D twin and P&ID, joined through one set of mappings.
 *
 * A field scene is a photograph of a piece of equipment with every visible component boxed
 * and classified. Each detection is then mapped onto the drawing: onto the equipment symbol
 * the scene depicts, onto the valves and instruments that symbol is really connected to, or
 * onto the pipe runs that touch it. The same detection id names the matching part of the 3D
 * model, so selecting a component anywhere — photo, model, table, drawing — selects it
 * everywhere.
 *
 * WHAT THE MAPPING RESTS ON
 *
 * The anchor is chosen, not guessed: on the OPEN100 main steam sheet the agent read the tag
 * printed at node `tank67` as RCS-SG-100, a steam generator, which is a shell-and-tube heat
 * exchanger. Everything else is resolved from the real topology around that anchor, and each
 * mapping records the rule that produced it, so a reviewer can see why a red handwheel in the
 * photo became a particular valve on the drawing — and, where the topology cannot say which
 * of two valves is upstream, the basis says so rather than implying it knows.
 *
 * The photograph is generated and the process values are simulated; both are labelled as
 * such wherever they are shown.
 */

import {
  equipmentNeighbours,
  traceConnections,
  type CanvasDrawing,
} from "@/lib/canvas/model";
import {
  hashString,
  seededRandom,
  type FailureCode,
  type PlantRegister,
} from "@/lib/canvas/engineering";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Scene definition
// ────────────────────────────────────────────────────────────────────────────────────────────

export type DetectionClass =
  | "shell"
  | "channel-head"
  | "nozzle"
  | "valve"
  | "gauge"
  | "transmitter"
  | "support"
  | "line";

/** Which role a detection plays, and so how it is mapped onto the drawing. */
export type DetectionRole =
  | "anchor-body"
  | "inlet-side"
  | "outlet-side"
  | "valve"
  | "local-indicator"
  | "transmitter";

export interface FieldDetection {
  readonly id: string;
  readonly label: string;
  readonly cls: DetectionClass;
  readonly role: DetectionRole;
  /** Pixel box in the source photograph: x0, y0, x1, y1. */
  readonly box: readonly [number, number, number, number];
  readonly description: string;
}

export interface FieldScene {
  readonly id: string;
  readonly title: string;
  readonly image: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Symbols to anchor on, in preference order. The first present on the sheet wins. */
  readonly preferredAnchors: readonly string[];
  readonly detections: readonly FieldDetection[];
}

/**
 * The heat exchanger inspection scene.
 *
 * Boxes were placed by hand on the 1448 × 1086 photograph and checked by rendering them back
 * onto it; they frame each component tightly enough to click.
 */
export const HEAT_EXCHANGER_SCENE: FieldScene = {
  id: "SCN-EXCHANGER",
  title: "Shell-and-tube heat exchanger — field inspection",
  image: "/demo/heat-exchanger-inspection.png",
  imageWidth: 1448,
  imageHeight: 1086,
  preferredAnchors: ["tank67"],
  detections: [
    {
      id: "D1",
      label: "Shell",
      cls: "shell",
      role: "anchor-body",
      box: [170, 360, 1140, 690],
      description: "Pressure shell containing the tube bundle; shell-side process stream.",
    },
    {
      id: "D2",
      label: "Channel head",
      cls: "channel-head",
      role: "anchor-body",
      box: [1130, 320, 1362, 708],
      description:
        "Bolted channel and tubesheet; tube-side cooling water enters and returns here.",
    },
    {
      id: "D3",
      label: "Inlet nozzle N1",
      cls: "nozzle",
      role: "inlet-side",
      box: [872, 205, 1035, 368],
      description: "Flanged shell-side inlet nozzle.",
    },
    {
      id: "D4",
      label: "Outlet nozzle N2",
      cls: "nozzle",
      role: "outlet-side",
      box: [912, 618, 1062, 740],
      description: "Flanged shell-side outlet nozzle.",
    },
    {
      id: "D5",
      label: "Handwheel valve (inlet)",
      cls: "valve",
      role: "valve",
      box: [803, 112, 915, 218],
      description: "Manual gate valve on the inlet line.",
    },
    {
      id: "D6",
      label: "Handwheel valve (riser)",
      cls: "valve",
      role: "valve",
      box: [64, 288, 162, 368],
      description: "Manual gate valve on the vertical riser.",
    },
    {
      id: "D7",
      label: "Handwheel valve (outlet)",
      cls: "valve",
      role: "valve",
      box: [1128, 842, 1252, 968],
      description: "Manual gate valve on the outlet line.",
    },
    {
      id: "D8",
      label: "Pressure gauge",
      cls: "gauge",
      role: "local-indicator",
      box: [1093, 183, 1160, 247],
      description: "Local dial pressure gauge on the inlet side.",
    },
    {
      id: "D9",
      label: "Transmitter",
      cls: "transmitter",
      role: "transmitter",
      box: [268, 286, 316, 328],
      description: "Field transmitter reporting to the control system.",
    },
    {
      id: "D10",
      label: "Saddle support (fixed)",
      cls: "support",
      role: "anchor-body",
      box: [325, 588, 455, 800],
      description: "Fixed saddle carrying the shell onto the skid.",
    },
    {
      id: "D11",
      label: "Saddle support (sliding)",
      cls: "support",
      role: "anchor-body",
      box: [782, 608, 918, 885],
      description: "Sliding saddle allowing thermal expansion of the shell.",
    },
    {
      id: "D12",
      label: "Inlet line",
      cls: "line",
      role: "inlet-side",
      box: [0, 438, 172, 548],
      description: "Flanged pipework into the front end of the exchanger.",
    },
    {
      id: "D13",
      label: "Outlet line",
      cls: "line",
      role: "outlet-side",
      box: [938, 705, 1425, 905],
      description: "Outlet pipework leaving the bottom nozzle.",
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────────────────────
// Mapping onto the drawing
// ────────────────────────────────────────────────────────────────────────────────────────────

export type MappingTarget =
  | {
      readonly kind: "asset";
      readonly nodeId: string;
      readonly tag: string;
      readonly name: string;
    }
  | {
      readonly kind: "part";
      readonly nodeId: string;
      readonly tag: string;
      readonly name: string;
    }
  | { readonly kind: "line"; readonly lineId: string; readonly number: string }
  | { readonly kind: "unmapped"; readonly reason: string };

/**
 * How far a mapping can be trusted.
 *
 * `high` — the component is part of the anchor symbol itself. `medium` — the drawing has a
 * symbol of the same class on the anchor's network, or the run is certain but its flow side
 * is not. `low` — the nearest symbol is of a different class, so the match is positional.
 */
export type MappingConfidence = "high" | "medium" | "low";

export interface MappedComponent {
  readonly detection: FieldDetection;
  readonly target: MappingTarget;
  readonly confidence: MappingConfidence;
  /** The rule that produced the mapping, in words a reviewer can check. */
  readonly basis: string;
}

/**
 * Pick the symbol the scene depicts.
 *
 * A preferred anchor wins when the sheet has it. Otherwise the vessel joined to the most
 * equipment is used, because a heat exchanger is the hub its valves and instruments hang off.
 * A sheet with no vessel has nothing to anchor on, and returns undefined.
 */
export function resolveAnchor(
  scene: FieldScene,
  drawing: CanvasDrawing,
  adjacency: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const ids = new Set(drawing.nodes.map((node) => node.id));
  const preferred = scene.preferredAnchors.find((id) => ids.has(id));
  if (preferred) return preferred;

  const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));
  const isEquipment = (id: string) =>
    ["valve", "instrumentation", "tank", "pump", "inlet/outlet"].includes(
      kindOf.get(id) ?? "",
    );
  let best: { id: string; joined: number } | undefined;
  for (const node of drawing.nodes) {
    if (node.kind !== "tank") continue;
    const joined = equipmentNeighbours(adjacency, isEquipment, node.id).length;
    if (!best || joined > best.joined) best = { id: node.id, joined };
  }
  return best?.id;
}

/**
 * What each field role looks for on the drawing: the symbol class, the stricter match that
 * makes it a like-for-like identification, and the words the basis uses for both.
 */
const FIELD_RULES: Record<
  "valve" | "local-indicator" | "transmitter",
  {
    readonly kind: string;
    readonly noun: string;
    readonly match: string;
    readonly exact: (register: PlantRegister, id: string) => boolean;
  }
> = {
  // A handwheel in the photo is a manually operated valve; an actuated one is a different item.
  valve: {
    kind: "valve",
    noun: "valve",
    match: "manual valve",
    exact: (register, id) => register.assets.get(id)?.category === "hand-valve",
  },
  // A dial gauge measures pressure locally and transmits nothing.
  "local-indicator": {
    kind: "instrumentation",
    noun: "instrument",
    match: "pressure gauge",
    exact: (register, id) =>
      /Pressure (Gauge|Indicator)$/.test(register.assets.get(id)?.name ?? ""),
  },
  transmitter: {
    kind: "instrumentation",
    noun: "instrument",
    match: "transmitter",
    exact: (register, id) => /Transmitter$/.test(register.assets.get(id)?.name ?? ""),
  },
};

/** Furthest a field component may be from its anchor, in graph hops, and still be mapped. */
export const MAX_FIELD_HOPS = 40;

/**
 * Map every detection in a scene onto the drawing.
 *
 * Field components are matched to the equipment *nearest* the anchor on the connected
 * network, walking through everything — connectors, crossings and other equipment alike.
 * That is deliberately not the rule {@link equipmentNeighbours} uses. That walk stops at
 * the first equipment on a path, which is right for "what is this joined to" but wrong
 * for "what is on this skid": an exchanger's pressure gauge normally sits behind its
 * isolation valve, so a walk that stops at the valve never reaches the gauge, and the
 * mapping came back with four of thirteen components unmatched.
 *
 * Within that reach a like-for-like symbol wins over a closer one of another class — a dial
 * gauge maps to a pressure gauge before a level indicator — and when no like-for-like
 * symbol exists the nearest of the class is used with `low` confidence, saying so.
 *
 * O(V + E) for one traversal of the anchor's connected network, then linear in detections.
 */
export function mapScene(
  scene: FieldScene,
  anchorId: string,
  drawing: CanvasDrawing,
  register: PlantRegister,
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly MappedComponent[] {
  const anchor = register.assets.get(anchorId);
  const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));
  // Nearest first, and within reach of a single skid.
  const joined = [...traceConnections(adjacency, anchorId)]
    .filter(
      ([id, hops]) => id !== anchorId && hops <= MAX_FIELD_HOPS && register.assets.has(id),
    )
    .map(([id, hops]) => ({ id, hops }))
    .sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));

  const used = new Set<string>();
  const take = (predicate: (id: string) => boolean) => {
    const found = joined.find(({ id }) => !used.has(id) && predicate(id));
    if (found) used.add(found.id);
    return found;
  };
  const anchorLines = register.linesByNode.get(anchorId) ?? [];

  return scene.detections.map((detection): MappedComponent => {
    if (!anchor) {
      return {
        detection,
        target: { kind: "unmapped", reason: "The anchor symbol has no register entry." },
        confidence: "low",
        basis: "No anchor",
      };
    }

    switch (detection.role) {
      case "anchor-body":
        return {
          detection,
          target: { kind: "part", nodeId: anchorId, tag: anchor.tag, name: anchor.name },
          confidence: "high",
          basis: `Part of ${anchor.tag}, the symbol this scene depicts`,
        };

      case "inlet-side":
      case "outlet-side": {
        // Two runs touch the anchor, but an undirected graph cannot say which one feeds it.
        // The assignment is by run size, and the basis says so.
        const index = detection.role === "inlet-side" ? 0 : 1;
        const lineId = anchorLines[index] ?? anchorLines[0];
        const line = lineId ? register.lines.get(lineId) : undefined;
        if (!line) {
          return {
            detection,
            target: { kind: "unmapped", reason: `No pipe run touches ${anchor.tag}.` },
            confidence: "low",
            basis: "No connected run",
          };
        }
        return {
          detection,
          target: { kind: "line", lineId: line.id, number: line.number },
          confidence: "medium",
          basis:
            anchorLines.length > 1
              ? `Run ${index + 1} of ${anchorLines.length} on ${anchor.tag}; flow side not established by the undirected graph`
              : `Only run on ${anchor.tag}`,
        };
      }

      case "valve":
      case "local-indicator":
      case "transmitter": {
        const rule = FIELD_RULES[detection.role];
        const exact = take(
          (id) => kindOf.get(id) === rule.kind && rule.exact(register, id),
        );
        const found = exact ?? take((id) => kindOf.get(id) === rule.kind);
        if (!found) {
          return {
            detection,
            target: {
              kind: "unmapped",
              reason: `No further ${rule.noun} within ${MAX_FIELD_HOPS} hops of ${anchor.tag}.`,
            },
            confidence: "low",
            basis: "No candidate in topology",
          };
        }
        const asset = register.assets.get(found.id)!;
        return {
          detection,
          target: { kind: "asset", nodeId: found.id, tag: asset.tag, name: asset.name },
          confidence: exact ? "medium" : "low",
          basis: exact
            ? `Nearest ${rule.match} on ${anchor.tag}'s network · ${found.hops} graph hops`
            : `No ${rule.match} within ${MAX_FIELD_HOPS} hops of ${anchor.tag}; nearest ${rule.noun} of another class · ${found.hops} graph hops`,
        };
      }
    }
  });
}

/** The source node a mapped component selects on the drawing, if it has one. */
export function nodeOf(component: MappedComponent): string | undefined {
  const { target } = component;
  return target.kind === "asset" || target.kind === "part" ? target.nodeId : undefined;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Process simulation
// ────────────────────────────────────────────────────────────────────────────────────────────

export type ScenarioId = "normal" | "fouling" | "tube-leak" | "inlet-valve-closed";

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: string;
  readonly summary: string;
  /** ISO 14224 failure mode the scenario exercises, if any. */
  readonly failureCode?: FailureCode;
  /** Detections the failure acts on, highlighted in the photo and the model. */
  readonly affects: readonly string[];
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "normal",
    name: "Normal operation",
    summary: "Clean surfaces, design flows, all valves in their operating positions.",
    affects: [],
  },
  {
    id: "fouling",
    name: "Tube-side fouling",
    summary:
      "Scale builds on the tube walls over the shift, adding thermal resistance. Duty falls, the shell outlet runs hotter and pressure drop climbs.",
    failureCode: "PDE",
    affects: ["D1", "D2", "D13"],
  },
  {
    id: "tube-leak",
    name: "Tube leak",
    summary:
      "A tube fails partway through the shift. Process stream leaks into the cooling water, which shows first as rising conductivity on the cooling-water return.",
    failureCode: "INL",
    affects: ["D2", "D13", "D4"],
  },
  {
    id: "inlet-valve-closed",
    name: "Inlet valve fails to open",
    summary:
      "The inlet valve does not open when commanded at mid-shift. Shell-side flow collapses to leakage and heat duty follows it.",
    failureCode: "FTO",
    affects: ["D5", "D3", "D1"],
  },
];

export interface ExchangerState {
  /** Heat duty, kW. */
  readonly dutyKw: number;
  /** Shell-side (process) outlet temperature, °C. */
  readonly shellOutletC: number;
  /** Tube-side (cooling water) outlet temperature, °C. */
  readonly tubeOutletC: number;
  /** Overall heat-transfer coefficient, W/m²·K. */
  readonly uValue: number;
  /** Shell-side pressure drop, bar. */
  readonly shellDpBar: number;
  /** Cooling-water return conductivity, µS/cm. */
  readonly conductivity: number;
}

/** Design basis. Chosen so the clean exchanger runs mid-band on every register trend. */
const DESIGN = {
  hotInletC: 240,
  coldInletC: 32,
  hotCapacityKwPerK: 90,
  coldCapacityKwPerK: 300,
  areaM2: 110,
  cleanU: 727,
  cleanDpBar: 0.42,
  baseConductivity: 350,
  foulingResistance: 0.00035,
} as const;

/**
 * Counter-flow effectiveness–NTU. Standard textbook relation; Cr < 1 always holds here.
 */
function effectiveness(ntu: number, cr: number): number {
  const e = Math.exp(-ntu * (1 - cr));
  return (1 - e) / (1 - cr * e);
}

/**
 * The exchanger's state under a scenario, at a point in the shift.
 *
 * @param progress - 0 at the start of the shift, 1 at the end. Fouling accumulates across
 *   it; the leak and the valve failure arrive as steps partway through.
 */
export function exchangerState(scenario: ScenarioId, progress: number): ExchangerState {
  const t = Math.min(1, Math.max(0, progress));
  let hotCapacity: number = DESIGN.hotCapacityKwPerK;
  let resistance = 0;
  let dpFactor = 1;
  let conductivity: number = DESIGN.baseConductivity;

  if (scenario === "fouling") {
    resistance = DESIGN.foulingResistance * t;
    dpFactor = 1 + 0.45 * t;
  } else if (scenario === "tube-leak" && t >= 0.6) {
    conductivity = DESIGN.baseConductivity + 1050 * Math.min(1, (t - 0.6) / 0.25);
    dpFactor = 0.96;
  } else if (scenario === "inlet-valve-closed" && t >= 0.5) {
    // Passing leakage through the closed seat, not zero flow.
    hotCapacity = DESIGN.hotCapacityKwPerK * 0.08;
  }

  const u = 1 / (1 / DESIGN.cleanU + resistance);
  const ua = (u * DESIGN.areaM2) / 1000;
  const cMin = Math.min(hotCapacity, DESIGN.coldCapacityKwPerK);
  const cMax = Math.max(hotCapacity, DESIGN.coldCapacityKwPerK);
  const eps = effectiveness(ua / cMin, cMin / cMax);
  const duty = eps * cMin * (DESIGN.hotInletC - DESIGN.coldInletC);
  const flowRatio = hotCapacity / DESIGN.hotCapacityKwPerK;

  return {
    dutyKw: duty,
    shellOutletC: DESIGN.hotInletC - duty / hotCapacity,
    tubeOutletC: DESIGN.coldInletC + duty / DESIGN.coldCapacityKwPerK,
    uValue: u,
    shellDpBar: DESIGN.cleanDpBar * dpFactor * flowRatio * flowRatio,
    conductivity,
  };
}

export interface ScenarioPoint {
  readonly hour: number;
  readonly state: ExchangerState;
}

/**
 * A 24-hour trend under a scenario, with a little deterministic measurement noise so it reads
 * as instrument data rather than a drawn curve.
 */
export function scenarioTrend(scenario: ScenarioId, points = 96): readonly ScenarioPoint[] {
  const random = seededRandom(hashString(`twin#${scenario}`));
  const series: ScenarioPoint[] = [];
  for (let index = 0; index < points; index += 1) {
    const progress = index / (points - 1);
    const clean = exchangerState(scenario, progress);
    const jitter = (scale: number) => (random() - 0.5) * scale;
    series.push({
      hour: progress * 24,
      state: {
        ...clean,
        dutyKw: clean.dutyKw * (1 + jitter(0.01)),
        shellOutletC: clean.shellOutletC + jitter(0.8),
        tubeOutletC: clean.tubeOutletC + jitter(0.4),
        conductivity: clean.conductivity + jitter(12),
      },
    });
  }
  return series;
}
