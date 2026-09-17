/**
 * Training samples, grounded answers and their verification, all built from the corpus.
 *
 * A sample is one registered field reference joined to everything the workspace knows about
 * its node: the drawn symbol and its geometry, the pipe run it sits on, the equipment it is
 * really connected to, its telemetry and its documents. Answers about a sample are composed
 * only from those facts, and the verifier then re-reads the answer *as text* and checks every
 * claim against the register, the graph and the live telemetry — so a claim that has gone
 * stale since the answer was written fails, as it should.
 */

import {
  equipmentNeighbours,
  type CanvasDrawing,
  type DrawingNode,
} from "@/lib/canvas/model";
import {
  fieldIdentity,
  type AssetRecord,
  type LineRecord,
  type PlantRegister,
} from "@/lib/canvas/engineering";
import { isEquipment } from "@/lib/canvas/taxonomy";
import { telemetryFor } from "@/lib/canvas/telemetry";
import { fieldReferencesFor, type FieldReference } from "@/lib/investigation/model";
import { HEAT_EXCHANGER_SCENE } from "@/lib/twin/scene";

import type { Stage } from "./stages";

export type NeighbourGroup = "equipment" | "instrument" | "process";

export interface SampleNeighbour {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly group: NeighbourGroup;
  readonly hops: number;
  /** True when this neighbour is itself a sample, so the graph can jump to it. */
  readonly sampled: boolean;
}

export interface LabSample {
  readonly nodeId: string;
  readonly annotationId: string;
  readonly tag: string;
  readonly name: string;
  readonly fieldClass: string;
  readonly image: string;
  /** Box around the device in the photograph, in percent of the image. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly node: DrawingNode;
  readonly asset: AssetRecord;
  readonly line: LineRecord | undefined;
  readonly neighbours: readonly SampleNeighbour[];
  readonly joinedCount: number;
  readonly evidence: {
    readonly fieldImages: number;
    readonly pid: number;
    readonly twin: number;
    readonly graph: number;
    readonly timeSeries: number;
    readonly manuals: number;
  };
}

function groupOf(asset: AssetRecord | undefined): NeighbourGroup {
  if (!asset) return "equipment";
  if (asset.category === "instrument") return "instrument";
  if (["vessel", "exchanger", "pump"].includes(asset.category)) return "process";
  return "equipment";
}

/**
 * The samples a stage shows, in its carousel order. A reference whose node is missing from the
 * sheet is skipped rather than faked, so another sheet can legitimately have none.
 */
export function buildSamples(
  stage: Stage,
  drawing: CanvasDrawing,
  register: PlantRegister,
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly LabSample[] {
  const references = new Map(fieldReferencesFor(drawing).map((ref) => [ref.nodeId, ref]));
  const nodeById = new Map(drawing.nodes.map((node) => [node.id, node]));
  const kindOf = (id: string) => nodeById.get(id)?.kind ?? "";
  const ordered = [
    ...stage.sampleNodes,
    ...[...references.keys()].filter((id) => !stage.sampleNodes.includes(id)),
  ];
  const chosen = ordered
    .filter((id) => references.has(id) && register.assets.has(id))
    .slice(0, 5);
  const sampled = new Set(chosen);

  return chosen.map((nodeId) => {
    const ref = references.get(nodeId)!;
    const asset = register.assets.get(nodeId)!;
    const node = nodeById.get(nodeId)!;
    const joined = equipmentNeighbours(
      adjacency,
      (id) => isEquipment(kindOf(id)),
      nodeId,
      60,
    );
    const neighbours = joined.slice(0, 5).map(({ id, hops }) => {
      const other = register.assets.get(id);
      return {
        id,
        tag: other?.tag ?? id,
        name: other?.name ?? kindOf(id),
        group: groupOf(other),
        hops,
        sampled: sampled.has(id),
      };
    });
    const exchanger = asset.category === "exchanger";
    const telemetryTags = [
      asset,
      ...joined.map(({ id }) => register.assets.get(id)),
    ].filter((item) => item?.telemetry).length;
    return {
      nodeId,
      annotationId: ref.annotationId,
      tag: asset.tag,
      name: asset.name,
      fieldClass: exchanger ? "Shell-and-tube heat exchanger" : ref.fieldClass,
      // The exchanger has its own inspection photograph with component-level detections; the
      // generic separator reference would contradict the register's identity for this node.
      image: exchanger ? HEAT_EXCHANGER_SCENE.image : ref.generatedImagePath,
      box: exchanger ? { x: 11.7, y: 33.1, width: 67, height: 30.4 } : ref.annotationBox,
      node,
      asset,
      line: register.lines.get(asset.lines[0] ?? ""),
      neighbours,
      joinedCount: joined.length,
      evidence: {
        fieldImages: exchanger ? HEAT_EXCHANGER_SCENE.detections.length : 1,
        pid: 1,
        twin: 1,
        graph: joined.length,
        timeSeries: telemetryTags,
        manuals: asset.documents.filter((doc) => doc.kind !== "P&ID").length,
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Grounded answers
// ────────────────────────────────────────────────────────────────────────────────────────────

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export interface GroundedAnswer {
  readonly question: string;
  readonly text: string;
  /** Kinds of evidence the answer cites, for its citation chips. */
  readonly cites: readonly ("P&ID" | "Trend" | "Procedure" | "Topology")[];
}

/**
 * Compose an answer about a sample from register facts only.
 *
 * `compact` produces the shorter answer a distilled student gives: fewer neighbours and no
 * document citation, which the verifier then scores on its own merits.
 */
export function groundedAnswer(
  sample: LabSample,
  register: PlantRegister,
  now: number,
  compact = false,
): GroundedAnswer {
  const { asset, line } = sample;
  const partner = asset.loop
    ? [...register.assets.values()].find(
        (a) =>
          a.loop === asset.loop &&
          a.nodeId !== asset.nodeId &&
          a.category !== asset.category,
      )
    : undefined;
  const measuring = asset.telemetry ? asset : partner?.telemetry ? partner : undefined;
  const live = measuring ? telemetryFor(measuring, register, "1H", now) : undefined;
  const neighbours = sample.neighbours.slice(0, compact ? 2 : 4).map((n) => n.tag);
  const procedure = asset.documents.find(
    (doc) => doc.kind === "IOM manual" || doc.kind === "Datasheet",
  );

  const parts: string[] = [];
  parts.push(
    compact
      ? `${asset.tag} is ${article(asset.name)} ${asset.name.toLowerCase()}${line ? ` on ${line.number}` : ""}.`
      : `The field image shows ${article(sample.fieldClass)} ${sample.fieldClass.toLowerCase()}, registered to ${asset.tag} (${asset.name})${line ? ` on line ${line.number}` : ""} of the ${register.system}.`,
  );
  if (neighbours.length) parts.push(`It is connected to ${neighbours.join(", ")}.`);
  if (partner && partner.category !== asset.category) {
    parts.push(`It shares loop ${asset.loop} with ${partner.tag}.`);
  }
  if (live) {
    const state = live.active ? `in ${live.active.level} alarm` : "within its alarm limits";
    parts.push(
      `${live.tag} reads ${live.current.pv.toFixed(2)} ${live.unit}, ${state} (normal ${live.normal[0]}–${live.normal[1]} ${live.unit}).`,
    );
  }
  if (!compact && procedure) parts.push(`Procedure reference: ${procedure.name}.`);

  const cites: GroundedAnswer["cites"][number][] = ["P&ID"];
  if (live) cites.push("Trend");
  if (!compact && procedure) cites.push("Procedure");
  if (neighbours.length) cites.push("Topology");

  return {
    question: `What is ${asset.tag} in the field image, what is it connected to, and is it operating normally?`,
    text: parts.join(" "),
    cites,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Verification
// ────────────────────────────────────────────────────────────────────────────────────────────

export type CheckId = "grounding" | "topology" | "registration" | "citation" | "simulator";

export interface Check {
  readonly id: CheckId;
  readonly label: string;
  /** Reward weight from the stage 3 contract. */
  readonly weight: number;
  readonly score: number;
  readonly pass: boolean;
  readonly detail: string;
}

export interface Verification {
  readonly checks: readonly Check[];
  readonly overall: number;
  readonly pass: boolean;
  /** Tags or line numbers the answer states that do not exist. */
  readonly fabricated: readonly string[];
}

const TAG = /\b[A-Z]{1,4}-\d{3,4}[A-Z]?\b/g;
const LINE = /\b\d{1,2}"-[A-Z]{2,3}-\d{4}-[A-Z]\d[A-Z]\b/g;
const PASS = 0.7;

/**
 * Check an answer against the corpus. Pure; O(answer length + neighbours).
 *
 * Every check re-derives its facts independently of the code that wrote the answer, so a
 * mismatch between the two is caught rather than assumed away.
 */
export function verifyAnswer(
  text: string,
  sample: LabSample,
  drawing: CanvasDrawing,
  register: PlantRegister,
  adjacency: ReadonlyMap<string, readonly string[]>,
  now: number,
): Verification {
  const lineNumbers = new Set([...register.lines.values()].map((line) => line.number));
  const lines = [...new Set(text.match(LINE) ?? [])];
  // Strip line numbers first: "3"-MS-1004-B1A" contains nothing tag-shaped we want.
  const tags = [...new Set(text.replace(LINE, " ").match(TAG) ?? [])];
  const fabricated = [
    ...tags.filter((tag) => !register.nodeByTag.has(tag)),
    ...lines.filter((line) => !lineNumbers.has(line)),
  ];
  // A real line number that is not the sample's own line is a grounding error too.
  const misplacedLines = lines.filter(
    (line) => lineNumbers.has(line) && sample.line && line !== sample.line.number,
  );
  const groundingTotal = tags.length + lines.length;
  const grounding = groundingTotal
    ? (groundingTotal - fabricated.length - misplacedLines.length) / groundingTotal
    : 0;

  // Topology: every tag after "connected to" must really be joined to the sample's node.
  const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));
  const joined = new Set(
    equipmentNeighbours(
      adjacency,
      (id) => isEquipment(kindOf.get(id) ?? ""),
      sample.nodeId,
      60,
    ).map(({ id }) => id),
  );
  const connectedClause = /connected to ([^.]*)\./.exec(text)?.[1] ?? "";
  const claimed = connectedClause.match(TAG) ?? [];
  const valid = claimed.filter((tag) => {
    const id = register.nodeByTag.get(tag);
    return id !== undefined && joined.has(id);
  });
  const topology = claimed.length ? valid.length / claimed.length : 1;

  // Registration: the photographed class, the drawn symbol and the register must agree.
  const identity = fieldIdentity(sample.fieldClass);
  const categoryAgrees =
    sample.asset.category === "exchanger"
      ? sample.node.kind === "tank"
      : identity === undefined
        ? false
        : identity.kind === "instrument"
          ? sample.asset.category === "instrument"
          : identity.kind === "vessel"
            ? sample.asset.category === "vessel"
            : identity.kind === sample.asset.category;
  const positioned = sample.node.positioned !== false && sample.node.width > 0;
  const kindAgrees = ["valve", "instrumentation", "tank"].includes(sample.node.kind);
  const registration = [categoryAgrees, positioned, kindAgrees].filter(Boolean).length / 3;

  // Citation: a named document must be one this asset actually holds.
  const cited = [...text.matchAll(/Procedure reference: ([^\s]+\.pdf)/g)].map((m) => m[1]!);
  const held = new Set(sample.asset.documents.map((doc) => doc.name));
  // An answer that cites nothing while documents exist is under-supported, not neutral.
  const citationScore = cited.length
    ? cited.filter((name) => held.has(name)).length / cited.length
    : sample.asset.documents.some((doc) => doc.kind !== "P&ID")
      ? 0.5
      : 1;

  // Simulator: a stated reading must still agree with the live trend, within noise.
  const reading = /([A-Z]{1,4}-\d{3,4}[A-Z]?) reads (-?[\d.]+) /.exec(text);
  let simulator = 1;
  let simulatorDetail = "No process reading claimed";
  if (reading) {
    const asset = register.assets.get(register.nodeByTag.get(reading[1]!) ?? "");
    const live = asset ? telemetryFor(asset, register, "1H", now) : undefined;
    if (!live) {
      simulator = 0;
      simulatorDetail = `${reading[1]} has no telemetry`;
    } else {
      const claimedValue = Number(reading[2]);
      const tolerance = Math.max(
        live.stats.sigma * 3,
        (live.normal[1] - live.normal[0]) * 0.05,
      );
      const error = Math.abs(claimedValue - live.current.pv);
      simulator = Math.max(0, 1 - error / (tolerance * 2));
      simulatorDetail = `Stated ${claimedValue.toFixed(2)}, live ${live.current.pv.toFixed(2)} ${live.unit}`;
    }
  }

  const checks: Check[] = [
    {
      id: "grounding",
      label: "Grounding parse",
      weight: 0.2,
      score: grounding,
      // Any invented or misplaced identifier fails the parse, however many others are right.
      pass: grounding >= PASS && fabricated.length === 0 && misplacedLines.length === 0,
      detail: misplacedLines.length
        ? `Line ${misplacedLines[0]} is not the line this component sits on`
        : `${groundingTotal - fabricated.length} of ${groundingTotal} tags and lines exist`,
    },
    {
      id: "topology",
      label: "Topology validation",
      weight: 0.15,
      score: topology,
      pass: topology >= PASS,
      detail: claimed.length
        ? `${valid.length} of ${claimed.length} connections are in the graph`
        : "No connection claimed",
    },
    {
      id: "registration",
      label: "Reference consistency",
      weight: 0.1,
      score: registration,
      pass: registration >= PASS,
      detail: categoryAgrees
        ? "Exercise class, symbol and register agree; plant identity unverified"
        : "Reference class disagrees with the exercise register",
    },
    {
      id: "citation",
      label: "Citation check",
      weight: 0.15,
      score: citationScore,
      pass: citationScore >= PASS,
      detail: cited.length
        ? `${cited.length} document${cited.length === 1 ? "" : "s"} cited, all held`
        : "No document cited",
    },
    {
      id: "simulator",
      label: "Simulator outcome",
      weight: 0.2,
      score: simulator,
      pass: simulator >= PASS,
      detail: simulatorDetail,
    },
  ];
  const weight = checks.reduce((sum, check) => sum + check.weight, 0);
  const overall =
    checks.reduce((sum, check) => sum + check.score * check.weight, 0) / weight -
    Math.min(0.2, fabricated.length * 0.1);
  // A fabricated tag or line is a hallucination: it fails the answer whatever else scored.
  return {
    checks,
    overall: Math.max(0, overall),
    pass: overall >= PASS && checks.every((c) => c.pass) && fabricated.length === 0,
    fabricated,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Corpus facts
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface CorpusFacts {
  readonly source: "backend" | "demo";
  /** Drawing / GraphML pairs the backend catalogue reports; null when it could not be read. */
  readonly drawings: number | null;
  readonly corpusFiles: number | null;
  readonly sheetNodes: number;
  readonly equipment: number;
  readonly fieldReferences: number;
  readonly twinDetections: number;
  readonly proceduralModels: number;
  readonly telemetryTags: number;
  readonly documents: number;
  readonly workOrders: number;
  readonly failureModes: number;
  readonly controlLoops: number;
  readonly alarmActivations24h: number;
}

export function corpusFacts(
  drawing: CanvasDrawing,
  register: PlantRegister,
  source: "backend" | "demo",
  drawings: number | null,
  corpusFiles: number | null,
  now: number,
): CorpusFacts {
  const assets = [...register.assets.values()];
  const references: readonly FieldReference[] = fieldReferencesFor(drawing);
  let alarms = 0;
  for (const asset of assets) {
    if (asset.category !== "instrument" || !asset.telemetry) continue;
    alarms +=
      telemetryFor(asset, register, "1D", now)?.events.filter((e) => e.state === "ACTIVE")
        .length ?? 0;
  }
  return {
    source,
    drawings,
    corpusFiles,
    sheetNodes: drawing.nodes.length,
    equipment: assets.length,
    fieldReferences:
      references.length + (register.assets.get("tank67")?.category === "exchanger" ? 1 : 0),
    twinDetections: HEAT_EXCHANGER_SCENE.detections.length,
    proceduralModels: new Set(references.map((ref) => ref.fieldClass)).size + 1,
    telemetryTags: assets.filter((asset) => asset.telemetry).length,
    documents: assets.reduce((sum, asset) => sum + asset.documents.length, 0),
    workOrders: assets.reduce((sum, asset) => sum + asset.workOrders.length, 0),
    failureModes: assets.reduce((sum, asset) => sum + asset.failureModes.length, 0),
    controlLoops: register.controlLoops,
    alarmActivations24h: alarms,
  };
}

/**
 * How many samples of each contract row this corpus can supply today, and what each count is.
 * Every number is derivable from the loaded sheet and register; none is a target.
 */
export function availability(
  stageId: Stage["id"],
  facts: CorpusFacts,
): ReadonlyMap<string, { readonly count: number; readonly basis: string }> {
  const drawings = facts.drawings ?? 1;
  const rows: [string, number, string][] =
    stageId === "pretraining"
      ? [
          [
            "pid",
            drawings,
            facts.drawings === null
              ? "Offline fixture sheet"
              : "Rasters in the corpus catalogue",
          ],
          ["graph", drawings, "GraphML files paired with a raster"],
          [
            "images",
            facts.fieldReferences,
            "Generated field references registered to nodes",
          ],
          ["3d", facts.proceduralModels, "Procedural device models, not CAD"],
          ["ts", facts.telemetryTags, "Simulated historian tags on this sheet"],
          [
            "docs",
            facts.documents + facts.workOrders,
            "Register documents and work orders",
          ],
        ]
      : stageId === "sft"
        ? [
            ["packages", facts.fieldReferences, "One per registered field reference"],
            [
              "alignment",
              facts.fieldReferences - 1 + facts.twinDetections,
              "Reference boxes plus exchanger detections",
            ],
            ["procedural", facts.failureModes, "Failure mode × maintenance task pairs"],
            ["topology", facts.equipment, "One neighbourhood trace per tag"],
            ["anomaly", facts.alarmActivations24h, "Alarm activations in the last 24 h"],
            ["telemetry", facts.telemetryTags * 4, "Tags × trend windows"],
          ]
        : stageId === "distillation"
          ? [
              ["traces", facts.equipment, "Composed grounded answers"],
              ["rollouts", facts.fieldReferences, "Verified sample answers"],
              [
                "correspondences",
                facts.fieldReferences - 1 + facts.twinDetections,
                "Image ↔ symbol pairs",
              ],
              ["simulation", 4, "Exchanger scenarios"],
              ["extraction", facts.equipment + facts.workOrders, "Tags and work orders"],
              ["dialogues", 0, "No dialogue logs are stored in this corpus"],
            ]
          : [];
  return new Map(rows.map(([id, count, basis]) => [id, { count, basis }]));
}

export const MODALITIES = ["P&ID", "Graph", "Images", "3D", "TS", "Docs"] as const;
export const MODALITY_NAMES = [
  "P&ID",
  "Graph",
  "Images",
  "3D",
  "Time-series",
  "Documents",
] as const;

/**
 * Links that actually exist between each pair of modalities on this sheet. Symmetric; the
 * diagonal is empty. A zero is shown as "no direct alignment", which is the truth for it.
 */
export function alignmentMatrix(
  facts: CorpusFacts,
): readonly (readonly (number | null)[])[] {
  const refs = facts.fieldReferences;
  const pairs: Record<string, number> = {
    "0-1": facts.sheetNodes,
    "0-2": refs,
    "0-3": facts.proceduralModels,
    "0-4": facts.telemetryTags,
    "0-5": facts.documents,
    "1-2": refs,
    "1-3": facts.twinDetections,
    "1-4": facts.controlLoops,
    "1-5": facts.workOrders,
    "2-3": facts.twinDetections,
    "2-4": 0,
    "2-5": 0,
    "3-4": 1,
    "3-5": 0,
    "4-5": facts.telemetryTags ? facts.workOrders : 0,
  };
  return MODALITIES.map((_, row) =>
    MODALITIES.map((__, column) => {
      if (row === column) return null;
      const key = row < column ? `${row}-${column}` : `${column}-${row}`;
      return pairs[key] ?? 0;
    }),
  );
}
