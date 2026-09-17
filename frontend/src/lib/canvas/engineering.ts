/**
 * The plant register behind a drawing.
 *
 * A corpus topology file records, per symbol, a class label and a bounding box — and nothing
 * an engineer works with: no tag, no service, no line number, no loop, no history. This
 * module builds that register so every symbol on the sheet can be addressed the way it would
 * be in a real plant: `FIT-1003`, a flow indicating transmitter on `4"-MS-1002-A1A`, in loop
 * 1003 with `FCV-1003`.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *
 * Real, read from the corpus:
 *   - each symbol's class, position and connections;
 *   - which symbols share a pipe network (a connected run of line connectors and crossings);
 *   - which instrument sits nearest to which valve through that network.
 *
 * Simulated, and flagged `simulated: true` wherever it is surfaced:
 *   - tags, names, loop and line numbers, service, status, telemetry, documents, work orders,
 *     and the likelihood ranking of failure modes.
 *
 * The simulated values follow the published conventions so they read correctly to an
 * engineer — ISA-5.1 identification letters, `size-service-sequence-class` line numbering,
 * ISO 14224 failure-mode codes — and they are deterministic: seeded from the drawing path and
 * source node, so the same sheet always yields the same register and a tag seen yesterday is
 * the same tag today. A printed tag the agent has read off the drawing always takes
 * precedence over a simulated one; that substitution happens at the call site.
 *
 * Complexity: O(V + E) to build the pipe networks, plus one bounded equipment search per
 * valve, O(valves · (V + E)); valves are a small fraction of any sheet.
 */

import { equipmentNeighbours, type CanvasDrawing, type DrawingNode } from "./model";
import { isEquipment } from "./taxonomy";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ────────────────────────────────────────────────────────────────────────────────────────────

/** FNV-1a: a stable 32-bit hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32: a small, fast, seedable generator returning values in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function weighted<T>(random: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]![0];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Vocabulary: ISA-5.1, line services, ISO 14224
// ────────────────────────────────────────────────────────────────────────────────────────────

/** ISA-5.1 first letters for the measured variables this register assigns. */
export const MEASURED_VARIABLES = {
  P: { name: "Pressure", unit: "barg", normal: [8, 12], alarmLow: 5, alarmHigh: 15 },
  T: { name: "Temperature", unit: "°C", normal: [180, 220], alarmLow: 150, alarmHigh: 245 },
  F: { name: "Flow", unit: "m³/h", normal: [42, 58], alarmLow: 25, alarmHigh: 72 },
  L: { name: "Level", unit: "%", normal: [40, 60], alarmLow: 15, alarmHigh: 85 },
  A: { name: "Analysis", unit: "ppm", normal: [2, 6], alarmLow: 0, alarmHigh: 10 },
  // Overall velocity; 7.1 mm/s is the ISO 10816-3 boundary into restricted operation.
  V: { name: "Vibration", unit: "mm/s", normal: [1.2, 2.8], alarmLow: 0, alarmHigh: 7.1 },
} as const;

export type Variable = keyof typeof MEASURED_VARIABLES;

/**
 * Fluid services a sheet may carry, with the code used in its line numbers.
 *
 * The codes are the conventional short forms; a real project defines its own in the piping
 * specification, and these stand in for one.
 */
export const SERVICES = [
  { code: "MS", name: "Main Steam" },
  { code: "CW", name: "Cooling Water" },
  { code: "BFW", name: "Boiler Feedwater" },
  { code: "CD", name: "Condensate" },
  { code: "FG", name: "Fuel Gas" },
  { code: "IA", name: "Instrument Air" },
  { code: "HC", name: "Hydrocarbon Process" },
  { code: "PW", name: "Process Water" },
] as const;

export type Service = (typeof SERVICES)[number];

/**
 * ISO 14224 failure modes, by the three-letter code the standard and OREDA use.
 *
 * Only codes confirmed against the standard's published tables are listed. Each carries the
 * condition an engineer would look for, so the panel is useful as a checklist and not only
 * as a vocabulary.
 */
export const FAILURE_MODES = {
  AIR: {
    name: "Abnormal instrument reading",
    indicator: "Reading inconsistent with redundant or adjacent measurements",
  },
  ELP: {
    name: "External leakage — process medium",
    indicator: "Visible weep at flanges, packing or body; gas detection alarm",
  },
  ERO: {
    name: "Erratic output",
    indicator: "Oscillating or hunting signal with no process change",
  },
  FTC: {
    name: "Failure to close on demand",
    indicator: "Position feedback disagrees with command after stroke time",
  },
  FTO: {
    name: "Failure to open on demand",
    indicator: "No flow response to an open command",
  },
  FTS: {
    name: "Failure to start on demand",
    indicator: "Motor trips or does not reach speed on start",
  },
  INL: {
    name: "Internal leakage",
    indicator: "Pressure equalisation across an isolated section",
  },
  LCP: {
    name: "Leakage in closed position",
    indicator: "Downstream flow or temperature rise with valve closed",
  },
  LOO: {
    name: "Low output",
    indicator: "Discharge pressure or flow below the design curve",
  },
  NOI: {
    name: "Abnormal noise",
    indicator: "Cavitation or bearing noise audible on rounds",
  },
  OHE: { name: "Overheating", indicator: "Bearing or casing temperature above baseline" },
  PDE: {
    name: "Parameter deviation",
    indicator: "Sustained drift outside calibration tolerance",
  },
  SPO: {
    name: "Spurious operation",
    indicator: "Unexpected trip or change of state without demand",
  },
  STD: {
    name: "Structural deficiency",
    indicator: "Wall thinning, cracking or corrosion found at inspection",
  },
  VIB: {
    name: "Abnormal vibration",
    indicator: "Overall velocity above the ISO 10816 alert band",
  },
} as const;

export type FailureCode = keyof typeof FAILURE_MODES;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Register types
// ────────────────────────────────────────────────────────────────────────────────────────────

export type AssetCategory =
  | "instrument"
  | "control-valve"
  | "safety-valve"
  | "hand-valve"
  | "vessel"
  | "exchanger"
  | "pump"
  | "off-page";

export type AssetStatus = "In service" | "Standby" | "Under maintenance";

export interface FailureAssessment {
  readonly code: FailureCode;
  readonly name: string;
  readonly indicator: string;
  /** Qualitative likelihood. Simulated: there is no failure history behind it. */
  readonly likelihood: "Low" | "Medium" | "High";
}

export interface TelemetrySpec {
  readonly measurement: string;
  readonly unit: string;
  readonly normal: readonly [number, number];
  readonly alarmLow: number;
  readonly alarmHigh: number;
  /** Seed for the series, so the trend for a tag is the same on every visit. */
  readonly seed: number;
}

export interface AssetDocument {
  readonly name: string;
  readonly kind: "Datasheet" | "Loop diagram" | "IOM manual" | "Inspection report" | "P&ID";
  readonly format: "PDF" | "PNG";
  readonly sizeKb: number;
  readonly date: string;
  /** False only for the drawing itself, which is a real corpus file. */
  readonly simulated: boolean;
}

export interface WorkOrder {
  readonly id: string;
  readonly title: string;
  readonly status: "Open" | "In progress" | "Planned" | "Closed";
  readonly priority: "High" | "Medium" | "Low";
  readonly type: "Corrective" | "Preventive" | "Inspection";
  readonly due: string;
  readonly failureCode: FailureCode;
}

export interface AssetRecord {
  readonly nodeId: string;
  readonly tag: string;
  readonly name: string;
  readonly category: AssetCategory;
  readonly description: string;
  /** Shared by a transmitter and the control valve it drives. */
  readonly loop?: string;
  readonly variable?: Variable;
  readonly status: AssetStatus;
  /** Line numbers of the pipe networks this asset sits on. Real topology, simulated numbers. */
  readonly lines: readonly string[];
  readonly failureModes: readonly FailureAssessment[];
  readonly telemetry?: TelemetrySpec;
  readonly documents: readonly AssetDocument[];
  readonly workOrders: readonly WorkOrder[];
  readonly simulated: true;
}

export interface LineRecord {
  readonly id: string;
  /** e.g. `4"-MS-1002-A1A` — size, service, sequence, piping class. */
  readonly number: string;
  readonly sizeInches: number;
  readonly service: Service;
  readonly pipeClass: string;
  /** Source node ids of the connectors and crossings that make up the run. Real. */
  readonly members: readonly string[];
  /** Source node ids of equipment on the run. Real. */
  readonly assets: readonly string[];
  readonly simulated: true;
}

export interface PlantRegister {
  readonly site: string;
  readonly area: string;
  readonly unit: string;
  readonly system: string;
  readonly service: Service;
  readonly assets: ReadonlyMap<string, AssetRecord>;
  readonly lines: ReadonlyMap<string, LineRecord>;
  /** Every line a source node belongs to or touches. */
  readonly linesByNode: ReadonlyMap<string, readonly string[]>;
  readonly nodeByTag: ReadonlyMap<string, string>;
  readonly controlLoops: number;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Construction
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The sheet number in a corpus path: `Dataset PID/10.graphml` → 10. */
function sheetNumber(path: string): number {
  const match = /(\d+)(?=\.[a-z]+$)/i.exec(path);
  return match ? Number(match[1]) : 0;
}

/**
 * The service a sheet carries.
 *
 * OPEN100 sheet 0 is a main steam system — its title block says so — so it is named
 * correctly rather than drawn from the list.
 */
function serviceFor(source: string, random: () => number): Service {
  if (/OPEN100\/0\.graphml$/.test(source)) return SERVICES[0];
  return pick(random, SERVICES);
}

/** Union-find, for grouping connected drafting nodes into pipe runs. */
function unionFind(ids: readonly string[]) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps later lookups near constant time.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  return { find, union };
}

const INSTRUMENT_FUNCTIONS: Record<string, string> = {
  IT: "Indicating Transmitter",
  T: "Transmitter",
  I: "Indicator",
  DT: "Differential Transmitter",
  SH: "Switch High",
};

/**
 * Device class used to keep the exercise register internally consistent with a reference.
 * This is an assumed scenario identity, not evidence about the actual source equipment.
 * A real register requires reviewed tag-to-photo correspondence and source provenance.
 */
export type FieldIdentity =
  | {
      readonly kind: "instrument";
      readonly variable: Variable;
      readonly fn: string;
      readonly name: string;
      /** Whether the device can be the measuring end of a control loop. */
      readonly loopCapable: boolean;
    }
  | { readonly kind: "hand-valve"; readonly name: string }
  | { readonly kind: "control-valve" }
  | { readonly kind: "vessel"; readonly name: string };

export function fieldIdentity(fieldClass: string): FieldIdentity | undefined {
  const text = fieldClass.toLowerCase();
  if (text.includes("handwheel") || text.includes("gate valve")) {
    return { kind: "hand-valve", name: "Manual Gate Valve" };
  }
  if (text.includes("control valve")) return { kind: "control-valve" };
  if (text.includes("pressure switch")) {
    return {
      kind: "instrument",
      variable: "P",
      fn: "SH",
      name: "Pressure Switch High",
      loopCapable: false,
    };
  }
  if (text.includes("pressure gauge")) {
    return {
      kind: "instrument",
      variable: "P",
      fn: "I",
      name: "Pressure Gauge",
      loopCapable: false,
    };
  }
  if (text.includes("differential-pressure") || text.includes("differential pressure")) {
    return {
      kind: "instrument",
      variable: "P",
      fn: "DT",
      name: "Differential Pressure Transmitter",
      loopCapable: true,
    };
  }
  if (text.includes("pressure transmitter")) {
    return {
      kind: "instrument",
      variable: "P",
      fn: "T",
      name: "Pressure Transmitter",
      loopCapable: true,
    };
  }
  if (text.includes("temperature transmitter")) {
    return {
      kind: "instrument",
      variable: "T",
      fn: "T",
      name: "Temperature Transmitter",
      loopCapable: true,
    };
  }
  if (text.includes("flow meter") || text.includes("flowmeter")) {
    return {
      kind: "instrument",
      variable: "F",
      fn: "T",
      name: "Electromagnetic Flow Transmitter",
      loopCapable: true,
    };
  }
  if (text.includes("level transmitter")) {
    return {
      kind: "instrument",
      variable: "L",
      fn: "T",
      name: "Radar Level Transmitter",
      loopCapable: true,
    };
  }
  if (text.includes("vibration")) {
    return {
      kind: "instrument",
      variable: "V",
      fn: "T",
      name: "Vibration Transmitter",
      loopCapable: false,
    };
  }
  if (text.includes("separator")) return { kind: "vessel", name: "Vertical Separator" };
  if (text.includes("drum")) return { kind: "vessel", name: "Knock-out Drum" };
  return undefined;
}

function instrumentName(variable: Variable, fn: string): string {
  const measured = MEASURED_VARIABLES[variable].name;
  // An indicator on pressure or temperature is, in the field, a gauge.
  if (fn === "I" && (variable === "P" || variable === "T")) return `${measured} Gauge`;
  return `${measured} ${INSTRUMENT_FUNCTIONS[fn]}`;
}

/** Failure modes relevant to each category, most characteristic first. */
const CATEGORY_FAILURES: Record<AssetCategory, readonly FailureCode[]> = {
  instrument: ["AIR", "ERO", "PDE", "SPO"],
  "control-valve": ["FTC", "FTO", "LCP", "ELP", "ERO"],
  "safety-valve": ["FTO", "SPO", "LCP", "ELP"],
  "hand-valve": ["FTC", "FTO", "LCP", "ELP"],
  vessel: ["STD", "ELP", "INL", "PDE"],
  // Tube leakage is internal leakage between the two sides; fouling shows first as a
  // parameter deviation in duty and approach temperature.
  exchanger: ["INL", "PDE", "ELP", "STD"],
  pump: ["FTS", "LOO", "VIB", "ELP", "OHE", "NOI"],
  "off-page": [],
};

function assessFailures(
  category: AssetCategory,
  random: () => number,
): FailureAssessment[] {
  return CATEGORY_FAILURES[category].map((code) => ({
    code,
    ...FAILURE_MODES[code],
    likelihood: weighted(random, [
      ["Low", 5],
      ["Medium", 3],
      ["High", 1],
    ] as const),
  }));
}

const DAY_MS = 86_400_000;

function isoDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

function documentsFor(
  tag: string,
  category: AssetCategory,
  drawingFile: string,
  random: () => number,
  now: number,
): AssetDocument[] {
  const dated = (days: number) => isoDate(now - Math.floor(random() * days) * DAY_MS);
  const documents: AssetDocument[] = [
    // The drawing is the one genuinely real document behind every asset on it.
    {
      name: drawingFile,
      kind: "P&ID",
      format: "PNG",
      sizeKb: 0,
      date: "",
      simulated: false,
    },
    {
      name: `${tag}_Datasheet.pdf`,
      kind: "Datasheet",
      format: "PDF",
      sizeKb: 180 + Math.floor(random() * 900),
      date: dated(900),
      simulated: true,
    },
  ];
  if (category === "instrument" || category === "control-valve") {
    documents.push({
      name: `${tag}_Loop-Diagram.pdf`,
      kind: "Loop diagram",
      format: "PDF",
      sizeKb: 90 + Math.floor(random() * 400),
      date: dated(700),
      simulated: true,
    });
  }
  if (category === "pump" || category.endsWith("valve")) {
    documents.push({
      name: `${tag}_IOM-Manual.pdf`,
      kind: "IOM manual",
      format: "PDF",
      sizeKb: 1200 + Math.floor(random() * 4000),
      date: dated(1400),
      simulated: true,
    });
  }
  if (category === "vessel" || category === "exchanger" || category === "safety-valve") {
    documents.push({
      name: `Inspection_${tag}.pdf`,
      kind: "Inspection report",
      format: "PDF",
      sizeKb: 300 + Math.floor(random() * 1500),
      date: dated(400),
      simulated: true,
    });
  }
  return documents;
}

const WORK_TITLES: Partial<Record<FailureCode, string>> = {
  AIR: "Verify reading against redundant measurement on",
  ERO: "Investigate erratic output on",
  PDE: "Recalibrate transmitter",
  SPO: "Investigate spurious trip on",
  FTC: "Stroke test and inspect actuator on",
  FTO: "Stroke test and inspect actuator on",
  LCP: "Seat leakage test on",
  ELP: "Repair packing leak on",
  STD: "Thickness survey of",
  INL: "Internal inspection of",
  FTS: "Troubleshoot start failure on",
  LOO: "Performance test of",
  VIB: "Vibration analysis on",
  OHE: "Bearing temperature check on",
  NOI: "Acoustic survey of",
};

function workOrdersFor(
  tag: string,
  failures: readonly FailureAssessment[],
  unitDigit: number,
  random: () => number,
  now: number,
): WorkOrder[] {
  if (!failures.length) return [];
  const count = weighted(random, [
    [0, 4],
    [1, 4],
    [2, 2],
    [3, 1],
  ] as const);
  const orders: WorkOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const failure = pick(random, failures);
    const status = weighted(random, [
      ["Open", 3],
      ["In progress", 2],
      ["Planned", 2],
      ["Closed", 3],
    ] as const);
    const offset = Math.floor(random() * 60) - (status === "Closed" ? 90 : 10);
    orders.push({
      id: `WO-2026-${unitDigit}${String(Math.floor(random() * 9000) + 1000)}`,
      title: `${WORK_TITLES[failure.code] ?? "Inspect"} ${tag}`,
      status,
      priority:
        failure.likelihood === "High"
          ? "High"
          : failure.likelihood === "Medium"
            ? "Medium"
            : "Low",
      type:
        failure.code === "STD" || failure.code === "INL"
          ? "Inspection"
          : pick(random, ["Corrective", "Preventive"] as const),
      due: isoDate(now + offset * DAY_MS),
      failureCode: failure.code,
    });
  }
  return orders;
}

/**
 * Build the register for one drawing.
 *
 * @param drawing - The drawing and its topology.
 * @param adjacency - Adjacency from {@link buildAdjacency}, reused rather than rebuilt.
 * @param now - Reference time for document and work-order dates, fixed in tests.
 */
export function buildPlantRegister(
  drawing: CanvasDrawing,
  adjacency: ReadonlyMap<string, readonly string[]>,
  now: number = Date.now(),
  exchangers: ReadonlySet<string> = new Set(),
  fieldClasses: ReadonlyMap<string, string> = new Map(),
): PlantRegister {
  const evidence = new Map<string, FieldIdentity>();
  for (const [nodeId, fieldClass] of fieldClasses) {
    const identity = fieldIdentity(fieldClass);
    if (identity) evidence.set(nodeId, identity);
  }
  const sheet = sheetNumber(drawing.source);
  const unitDigit = (sheet % 9) + 1;
  const sheetRandom = seededRandom(hashString(drawing.source));
  const service = serviceFor(drawing.source, sheetRandom);
  const folder = drawing.source.split("/").slice(0, -1).join("/") || "Corpus";
  const drawingFile = drawing.imagePath.split("/").at(-1) ?? drawing.imagePath;

  const nodeById = new Map(drawing.nodes.map((node) => [node.id, node]));
  const equipmentIds = new Set(
    drawing.nodes.filter((node) => isEquipment(node.kind)).map((node) => node.id),
  );
  const isEquipmentId = (id: string) => equipmentIds.has(id);

  // ── Pipe runs: connected components of the drafting apparatus ─────────────────────────────
  const drafting = drawing.nodes
    .filter((node) => !equipmentIds.has(node.id))
    .map((n) => n.id);
  const sets = unionFind(drafting);
  const assetsTouching = new Map<string, Set<string>>();
  for (const edge of drawing.edges) {
    const sourceIsKit = !equipmentIds.has(edge.source);
    const targetIsKit = !equipmentIds.has(edge.target);
    if (sourceIsKit && targetIsKit) sets.union(edge.source, edge.target);
  }
  for (const edge of drawing.edges) {
    for (const [asset, kit] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      if (equipmentIds.has(asset) && !equipmentIds.has(kit)) {
        const root = sets.find(kit);
        const bucket = assetsTouching.get(root) ?? new Set<string>();
        bucket.add(asset);
        assetsTouching.set(root, bucket);
      }
    }
  }

  const runs = new Map<string, string[]>();
  for (const id of drafting) {
    const root = sets.find(id);
    const members = runs.get(root) ?? [];
    members.push(id);
    runs.set(root, members);
  }

  // Busiest runs first, so the main headers get the lowest line numbers, as they would on a
  // real line list.
  const orderedRuns = [...runs.entries()].sort(
    (a, b) =>
      (assetsTouching.get(b[0])?.size ?? 0) - (assetsTouching.get(a[0])?.size ?? 0) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0]),
  );

  const lines = new Map<string, LineRecord>();
  const linesByNode = new Map<string, string[]>();
  const addLine = (nodeId: string, lineId: string) => {
    const list = linesByNode.get(nodeId) ?? [];
    if (!list.includes(lineId)) list.push(lineId);
    linesByNode.set(nodeId, list);
  };

  orderedRuns.forEach(([root, members], index) => {
    const random = seededRandom(hashString(`${drawing.source}#line#${root}`));
    const assets = [...(assetsTouching.get(root) ?? [])].sort();
    // Bore grows with the number of branches a run serves, so a header feeding twenty
    // assets is never drawn smaller than a branch feeding three. Only the smallest runs,
    // where the choice carries no information, are left to the seed.
    const sizeInches =
      assets.length >= 12
        ? 10
        : assets.length >= 6
          ? 8
          : assets.length >= 4
            ? 6
            : assets.length >= 2
              ? pick(random, [3, 4])
              : pick(random, [1, 2]);
    const pipeClass = pick(random, ["A1A", "B1A", "C2A", "D1B"]);
    const sequence = unitDigit * 1000 + index + 1;
    const id = `L${sequence}`;
    lines.set(id, {
      id,
      number: `${sizeInches}"-${service.code}-${sequence}-${pipeClass}`,
      sizeInches,
      service,
      pipeClass,
      members,
      assets,
      simulated: true,
    });
    for (const member of members) addLine(member, id);
    for (const asset of assets) addLine(asset, id);
  });

  // ── Loops: pair each valve with its nearest instrument ────────────────────────────────────
  const kindOf = (id: string) => nodeById.get(id)?.kind ?? "";
  const valves = drawing.nodes.filter((node) => node.kind === "valve");
  const pairs: { valve: string; instrument: string; hops: number }[] = [];
  const nearest = new Map<string, readonly { id: string; hops: number }[]>();
  for (const valve of valves) {
    const joined = equipmentNeighbours(adjacency, isEquipmentId, valve.id, 12);
    nearest.set(valve.id, joined);
    // A photographed handwheel valve is not modulated by anything.
    if (evidence.get(valve.id)?.kind === "hand-valve") continue;
    for (const { id, hops } of joined) {
      const identity = evidence.get(id);
      if (identity?.kind === "instrument" && !identity.loopCapable) continue;
      if (kindOf(id) === "instrumentation")
        pairs.push({ valve: valve.id, instrument: id, hops });
    }
  }
  pairs.sort((a, b) => a.hops - b.hops || a.valve.localeCompare(b.valve));
  const loopOfValve = new Map<string, string>();
  const loopOfInstrument = new Map<string, string>();
  for (const pair of pairs) {
    if (loopOfValve.has(pair.valve) || loopOfInstrument.has(pair.instrument)) continue;
    loopOfValve.set(pair.valve, pair.instrument);
    loopOfInstrument.set(pair.instrument, pair.valve);
  }

  // ── Tags ──────────────────────────────────────────────────────────────────────────────────
  const assets = new Map<string, AssetRecord>();
  const nodeByTag = new Map<string, string>();
  let loopSequence = 0;
  let handSequence = 0;
  let vesselSequence = 0;
  let pumpSequence = 0;
  let pageSequence = 0;
  const loopVariable = new Map<string, Variable>();

  const nextLoop = () => String(unitDigit * 1000 + (loopSequence += 1));

  /** Guarantees uniqueness even if two derivations ever collide. */
  const claim = (tag: string): string => {
    let candidate = tag;
    let suffix = 0;
    while (nodeByTag.has(candidate)) {
      suffix += 1;
      candidate = `${tag}${String.fromCharCode(64 + suffix)}`;
    }
    return candidate;
  };

  const variableFor = (node: DrawingNode, random: () => number): Variable => {
    // An instrument beside a vessel is most often measuring its level, and one beside a pump
    // its discharge pressure. Otherwise the mix follows a typical process plant.
    const neighbour = equipmentNeighbours(adjacency, isEquipmentId, node.id, 3)[0];
    const neighbourKind = neighbour ? kindOf(neighbour.id) : "";
    if (neighbourKind === "tank" && random() < 0.7) return "L";
    if (neighbourKind === "pump" && random() < 0.7) return "P";
    return weighted(random, [
      ["P", 30],
      ["T", 25],
      ["F", 22],
      ["L", 13],
      ["A", 10],
    ] as const);
  };

  const ordered = [...drawing.nodes]
    .filter((node) => equipmentIds.has(node.id))
    // Reading order — top to bottom, left to right — so numbers climb across the sheet the
    // way a draughtsman numbers them.
    .sort((a, b) => Math.round(a.y / 120) - Math.round(b.y / 120) || a.x - b.x);

  const register = (record: Omit<AssetRecord, "simulated">) => {
    const tag = claim(record.tag);
    const final: AssetRecord = { ...record, tag, simulated: true };
    assets.set(record.nodeId, final);
    nodeByTag.set(tag, record.nodeId);
  };

  const common = (node: DrawingNode, category: AssetCategory, tag: string) => {
    const random = seededRandom(hashString(`${drawing.source}#asset#${node.id}`));
    const failures = assessFailures(category, random);
    return {
      random,
      failures,
      status: weighted(random, [
        ["In service", 17],
        ["Standby", 2],
        ["Under maintenance", 1],
      ] as const) as AssetStatus,
      documents: documentsFor(tag, category, drawingFile, random, now),
      workOrders: workOrdersFor(tag, failures, unitDigit, random, now),
    };
  };

  // Instruments first: a control valve takes its loop number and variable from them.
  for (const node of ordered.filter((n) => n.kind === "instrumentation")) {
    const random = seededRandom(hashString(`${drawing.source}#var#${node.id}`));
    const identity = evidence.get(node.id);
    const photographed = identity?.kind === "instrument" ? identity : undefined;
    const variable = photographed?.variable ?? variableFor(node, random);
    const loop = nextLoop();
    const paired = loopOfInstrument.has(node.id);
    const fn = photographed?.fn ?? (paired ? "IT" : pick(random, ["T", "I", "IT"]));
    const tag = `${variable}${fn}-${loop}`;
    loopVariable.set(node.id, variable);
    const base = common(node, "instrument", tag);
    const spec = MEASURED_VARIABLES[variable];
    const name = photographed?.name ?? instrumentName(variable, fn);
    register({
      nodeId: node.id,
      tag,
      name,
      category: "instrument",
      description: `${name} measuring ${spec.name.toLowerCase()} on the ${service.name.toLowerCase()} system${paired ? ", driving a control loop" : ""}${photographed ? "; reference-based exercise identity, not plant-verified" : ""}.`,
      loop,
      variable,
      status: base.status,
      lines: linesByNode.get(node.id) ?? [],
      failureModes: base.failures,
      telemetry: {
        measurement: `${spec.name}`,
        unit: spec.unit,
        normal: spec.normal,
        alarmLow: spec.alarmLow,
        alarmHigh: spec.alarmHigh,
        seed: hashString(`${drawing.source}#trend#${node.id}`),
      },
      documents: base.documents,
      workOrders: base.workOrders,
    });
  }

  for (const node of ordered) {
    if (node.kind === "instrumentation") continue;

    if (node.kind === "valve") {
      const instrument = loopOfValve.get(node.id);
      if (instrument) {
        const partner = assets.get(instrument)!;
        const variable = loopVariable.get(instrument)!;
        const tag = `${variable}CV-${partner.loop}`;
        const base = common(node, "control-valve", tag);
        register({
          nodeId: node.id,
          tag,
          name: `${MEASURED_VARIABLES[variable].name} Control Valve`,
          category: "control-valve",
          description: `Modulating ${MEASURED_VARIABLES[variable].name.toLowerCase()} control valve, final element of loop ${partner.loop} with ${partner.tag}.`,
          loop: partner.loop,
          variable,
          status: base.status,
          lines: linesByNode.get(node.id) ?? [],
          failureModes: base.failures,
          telemetry: {
            measurement: "Valve position",
            unit: "% open",
            normal: [35, 65],
            alarmLow: 5,
            alarmHigh: 95,
            seed: hashString(`${drawing.source}#trend#${node.id}`),
          },
          documents: base.documents,
          workOrders: base.workOrders,
        });
        continue;
      }

      // An unpaired valve beside a vessel is taken as its relief; elsewhere, an isolation
      // valve. Both are what a reviewer would most likely find at that position.
      const photographedHand = evidence.get(node.id)?.kind === "hand-valve";
      const besideVessel =
        !photographedHand &&
        (nearest.get(node.id) ?? []).some(
          ({ id, hops }) => kindOf(id) === "tank" && hops <= 4,
        );
      if (besideVessel) {
        const tag = `PSV-${unitDigit * 1000 + (handSequence += 1)}`;
        const base = common(node, "safety-valve", tag);
        register({
          nodeId: node.id,
          tag,
          name: "Pressure Safety Valve",
          category: "safety-valve",
          description: `Spring-loaded relief protecting the adjacent vessel against overpressure on the ${service.name.toLowerCase()} system.`,
          status: base.status,
          lines: linesByNode.get(node.id) ?? [],
          failureModes: base.failures,
          documents: base.documents,
          workOrders: base.workOrders,
        });
      } else {
        const tag = `HV-${unitDigit * 1000 + (handSequence += 1)}`;
        const base = common(node, "hand-valve", tag);
        const drawnStyle = pick(base.random, ["Gate", "Globe", "Ball", "Butterfly"]);
        const style = photographedHand ? "Gate" : drawnStyle;
        register({
          nodeId: node.id,
          tag,
          name: `Manual ${style} Valve`,
          category: "hand-valve",
          description: `Manually operated ${style.toLowerCase()} valve for isolation on the ${service.name.toLowerCase()} system.`,
          status: base.status,
          lines: linesByNode.get(node.id) ?? [],
          failureModes: base.failures,
          documents: base.documents,
          workOrders: base.workOrders,
        });
      }
      continue;
    }

    // A vessel symbol the caller knows to be a heat exchanger — because a field scene is
    // mapped onto it, or because its printed tag says so — takes the exchanger identity
    // everywhere, so the canvas, the twin and the agent all call it the same thing.
    if (node.kind === "tank" && exchangers.has(node.id)) {
      const tag = `E-${unitDigit}${String((vesselSequence += 1)).padStart(2, "0")}`;
      const base = common(node, "exchanger", tag);
      register({
        nodeId: node.id,
        tag,
        name: "Shell-and-Tube Heat Exchanger",
        category: "exchanger",
        description: `Shell-and-tube heat exchanger on the ${service.name.toLowerCase()} system, transferring heat between the shell-side process stream and tube-side cooling water.`,
        status: base.status,
        lines: linesByNode.get(node.id) ?? [],
        failureModes: base.failures,
        telemetry: {
          measurement: "Shell outlet temperature",
          unit: "°C",
          normal: [118, 132],
          alarmLow: 95,
          alarmHigh: 150,
          seed: hashString(`${drawing.source}#trend#${node.id}`),
        },
        documents: base.documents,
        workOrders: base.workOrders,
      });
      continue;
    }

    if (node.kind === "tank") {
      const tag = `V-${unitDigit}${String((vesselSequence += 1)).padStart(2, "0")}`;
      const base = common(node, "vessel", tag);
      const photographed = evidence.get(node.id);
      const style =
        photographed?.kind === "vessel"
          ? photographed.name
          : pick(base.random, [
              "Separator Drum",
              "Knock-out Drum",
              "Storage Vessel",
              "Surge Drum",
            ]);
      register({
        nodeId: node.id,
        tag,
        name: style,
        category: "vessel",
        description: `${style} on the ${service.name.toLowerCase()} system, rated to the line class of its connecting pipework.`,
        status: base.status,
        lines: linesByNode.get(node.id) ?? [],
        failureModes: base.failures,
        telemetry: {
          measurement: "Level",
          unit: "%",
          normal: [40, 60],
          alarmLow: 15,
          alarmHigh: 85,
          seed: hashString(`${drawing.source}#trend#${node.id}`),
        },
        documents: base.documents,
        workOrders: base.workOrders,
      });
      continue;
    }

    if (node.kind === "pump") {
      const tag = `P-${unitDigit}${String((pumpSequence += 1)).padStart(2, "0")}A`;
      const base = common(node, "pump", tag);
      register({
        nodeId: node.id,
        tag,
        name: "Centrifugal Pump",
        category: "pump",
        description: `Electric-motor-driven centrifugal pump on the ${service.name.toLowerCase()} system.`,
        status: base.status,
        lines: linesByNode.get(node.id) ?? [],
        failureModes: base.failures,
        telemetry: {
          measurement: "Discharge pressure",
          unit: "barg",
          normal: [9, 13],
          alarmLow: 6,
          alarmHigh: 16,
          seed: hashString(`${drawing.source}#trend#${node.id}`),
        },
        documents: base.documents,
        workOrders: base.workOrders,
      });
      continue;
    }

    if (node.kind === "inlet/outlet") {
      const reference = sheet + (pageSequence % 2 === 0 ? 1 : -1);
      const tag = `OPC-${unitDigit}${String((pageSequence += 1)).padStart(2, "0")}`;
      const base = common(node, "off-page", tag);
      register({
        nodeId: node.id,
        tag,
        name: "Off-page Connector",
        category: "off-page",
        description: `Continuation of the ${service.name.toLowerCase()} line ${reference >= 0 ? `to sheet ${reference}` : "from an upstream sheet"}.`,
        status: "In service",
        lines: linesByNode.get(node.id) ?? [],
        failureModes: [],
        documents: base.documents.slice(0, 1),
        workOrders: [],
      });
    }
  }

  return {
    site: folder,
    area: `Area ${unitDigit}0`,
    unit: `Unit ${unitDigit}00`,
    system: `${service.name} System`,
    service,
    assets,
    lines,
    linesByNode,
    nodeByTag,
    controlLoops: loopOfValve.size,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Telemetry
// ────────────────────────────────────────────────────────────────────────────────────────────

export const TREND_WINDOWS = {
  "1H": { span: 3_600_000, points: 60 },
  "8H": { span: 28_800_000, points: 96 },
  "1D": { span: 86_400_000, points: 96 },
  "1W": { span: 604_800_000, points: 168 },
} as const;

export type TrendWindow = keyof typeof TREND_WINDOWS;

export interface TrendPoint {
  readonly t: number;
  readonly v: number;
}

/**
 * A simulated historian trend for one tag.
 *
 * A mean-reverting random walk inside the normal band with a slow cycle on top — the shape
 * a healthy regulated variable has — seeded per tag so the same tag always draws the same
 * history. Time is bucketed to the window's resolution so the series does not shimmer on
 * every render.
 */
export function simulateTrend(
  spec: TelemetrySpec,
  window: TrendWindow,
  now: number = Date.now(),
): readonly TrendPoint[] {
  const { span, points } = TREND_WINDOWS[window];
  const step = span / points;
  const end = Math.floor(now / step) * step;
  const random = seededRandom(spec.seed ^ hashString(window));
  const [low, high] = spec.normal;
  const mid = (low + high) / 2;
  const band = (high - low) / 2;
  let value = mid + (random() - 0.5) * band;
  const series: TrendPoint[] = [];
  for (let index = 0; index < points; index += 1) {
    const cycle = Math.sin((index / points) * Math.PI * 4 + (spec.seed % 7)) * band * 0.35;
    value += (mid + cycle - value) * 0.18 + (random() - 0.5) * band * 0.45;
    series.push({ t: end - (points - 1 - index) * step, v: Number(value.toFixed(2)) });
  }
  return series;
}
