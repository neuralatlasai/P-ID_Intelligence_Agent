/**
 * The data contract as a flow: contract sources → the keys they are joined on → the model
 * inputs those joins feed. Pure functions of the stage and the corpus facts; every count is
 * a real corpus count (availability, alignment matrix), never a target.
 *
 * Pretraining joins come from the alignment matrix: each modality pair is joined on one key,
 * and the pair's link count flows from both of its sources into that key. The instruction and
 * distillation stages consume task datasets rather than raw modalities, so each dataset row
 * routes its available count through the key it is assembled on.
 */

import { alignmentMatrix, availability, type CorpusFacts } from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";

import type { ModalityId } from "./conversion";

export type JoinKey =
  | "node_id"
  | "annotation_id"
  | "twin_component"
  | "historian_tag"
  | "asset_ref"
  | "timestamp"
  | "prompt_id"
  | "session_id";

/** Key order, top to bottom, so edges cross as little as the source order allows. */
const KEY_ORDER: readonly JoinKey[] = [
  "node_id",
  "annotation_id",
  "twin_component",
  "timestamp",
  "historian_tag",
  "prompt_id",
  "asset_ref",
  "session_id",
];

/** Input order: the conversion lanes' order. */
const INPUT_ORDER: readonly ModalityId[] = [
  "vision",
  "drawing",
  "topology",
  "spatial",
  "text",
  "telemetry",
  "documents",
  "target",
];

/** What each key means, for the accessible description only. */
export const KEY_MEANING: Record<JoinKey, string> = {
  node_id: "GraphML node id shared by the drawn symbol and the topology",
  annotation_id: "field reference registered to a symbol by its bounding box",
  twin_component: "3D twin component matched to a node or photograph",
  historian_tag: "historian tag binding a trend to an instrument or loop",
  asset_ref: "asset register reference filing a document or work order",
  timestamp: "time window aligning a photograph with a trend",
  prompt_id: "prompt a teacher trace or verified rollout answers",
  session_id: "dialogue session id",
};

/** Pretraining: which key joins each alignment-matrix pair (indices into MODALITIES). */
const PAIR_KEY: Record<string, JoinKey> = {
  "0-1": "node_id",
  "0-2": "annotation_id",
  "1-2": "annotation_id",
  "0-3": "twin_component",
  "1-3": "twin_component",
  "2-3": "twin_component",
  "0-4": "historian_tag",
  "1-4": "historian_tag",
  "3-4": "historian_tag",
  "2-4": "timestamp",
  "0-5": "asset_ref",
  "1-5": "asset_ref",
  "2-5": "asset_ref",
  "3-5": "asset_ref",
  "4-5": "asset_ref",
};

/** Pretraining: the model inputs a joined key feeds. */
const KEY_INPUTS: Record<JoinKey, readonly ModalityId[]> = {
  node_id: ["drawing", "topology"],
  annotation_id: ["vision", "drawing"],
  twin_component: ["spatial"],
  historian_tag: ["telemetry"],
  asset_ref: ["documents", "text"],
  timestamp: ["vision", "telemetry"],
  prompt_id: ["text", "target"],
  session_id: ["text"],
};

type Route = readonly (readonly [JoinKey, readonly ModalityId[]])[];

/** Dataset rows (instruction and distillation stages): key and inputs per row. */
const ROW_ROUTES: Record<string, Route> = {
  // Stage 2
  packages: [
    ["annotation_id", ["vision", "drawing"]],
    ["asset_ref", ["documents", "text"]],
  ],
  alignment: [["annotation_id", ["vision", "drawing"]]],
  procedural: [["asset_ref", ["documents", "text"]]],
  topology: [["node_id", ["topology", "text"]]],
  anomaly: [["historian_tag", ["telemetry", "text"]]],
  telemetry: [["historian_tag", ["telemetry", "text"]]],
  // Stage 4
  traces: [["prompt_id", ["text", "target"]]],
  rollouts: [["prompt_id", ["text", "target"]]],
  correspondences: [["annotation_id", ["vision", "drawing"]]],
  simulation: [["historian_tag", ["telemetry", "text"]]],
  extraction: [["asset_ref", ["documents", "text"]]],
  dialogues: [["session_id", ["text"]]],
};

export interface JoinSource {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly target: number;
  readonly targetLabel: string;
  readonly volume: string;
  readonly notes: string;
  /** Real count available today. */
  readonly count: number;
  readonly basis: string;
}

export interface JoinNode<Id extends string> {
  readonly id: Id;
  /** Links (pretraining) or records (datasets) flowing through. */
  readonly count: number;
}

export interface JoinEdge {
  readonly from: string;
  readonly to: string;
  readonly stage: "join" | "input";
  readonly count: number;
}

export interface JoinGraph {
  readonly sources: readonly JoinSource[];
  readonly joins: readonly JoinNode<JoinKey>[];
  readonly inputs: readonly JoinNode<ModalityId>[];
  readonly edges: readonly JoinEdge[];
  /** Largest edge count, the width scale's top. */
  readonly max: number;
}

export function joinGraph(stage: Stage, facts: CorpusFacts): JoinGraph {
  const available = availability(stage.id, facts);
  const sources: JoinSource[] = stage.contract.map((row) => ({
    id: row.id,
    name: row.name,
    format: row.format,
    target: row.target,
    targetLabel: row.targetLabel,
    volume: row.volume,
    notes: row.notes,
    count: Math.max(0, available.get(row.id)?.count ?? 0),
    basis: available.get(row.id)?.basis ?? "",
  }));

  const toJoin = new Map<string, number>();
  const toInput = new Map<string, number>();
  const joinCount = new Map<JoinKey, number>();
  const add = (map: Map<string, number>, key: string, value: number) =>
    map.set(key, (map.get(key) ?? 0) + value);

  if (stage.id === "pretraining") {
    const matrix = alignmentMatrix(facts);
    for (const [pair, key] of Object.entries(PAIR_KEY)) {
      const [a, b] = pair.split("-").map(Number) as [number, number];
      const value = matrix[a]?.[b] ?? 0;
      for (const index of [a, b]) {
        const source = sources[index];
        if (source) add(toJoin, `${source.id}>${key}`, value ?? 0);
      }
      joinCount.set(key, (joinCount.get(key) ?? 0) + (value ?? 0));
    }
    for (const [key, count] of joinCount) {
      for (const input of KEY_INPUTS[key]) add(toInput, `${key}>${input}`, count);
    }
  } else {
    for (const source of sources) {
      for (const [key, inputs] of ROW_ROUTES[source.id] ?? []) {
        add(toJoin, `${source.id}>${key}`, source.count);
        joinCount.set(key, (joinCount.get(key) ?? 0) + source.count);
        for (const input of inputs) add(toInput, `${key}>${input}`, source.count);
      }
    }
  }

  const edges: JoinEdge[] = [];
  for (const [id, count] of toJoin) {
    const [from, to] = id.split(">") as [string, string];
    edges.push({ from, to, stage: "join", count });
  }
  const inputCount = new Map<ModalityId, number>();
  for (const [id, count] of toInput) {
    const [from, to] = id.split(">") as [string, ModalityId];
    edges.push({ from, to, stage: "input", count });
    inputCount.set(to, (inputCount.get(to) ?? 0) + count);
  }
  const joins = KEY_ORDER.filter((key) => joinCount.has(key)).map((key) => ({
    id: key,
    count: joinCount.get(key)!,
  }));
  const inputs = INPUT_ORDER.filter((id) => inputCount.has(id)).map((id) => ({
    id,
    count: inputCount.get(id)!,
  }));
  const max = Math.max(1, ...edges.map((edge) => edge.count));
  return { sources, joins, inputs, edges, max };
}

/** Stroke width for a count on the graph's log scale; 0 for an empty join. */
export function edgeWidth(count: number, max: number, widest = 10): number {
  if (count <= 0) return 0;
  return 1.25 + (widest - 1.25) * (Math.log1p(count) / Math.log1p(Math.max(1, max)));
}
