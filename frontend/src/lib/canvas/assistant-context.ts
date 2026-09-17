import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import { buildAdjacency, equipmentNeighbours, traceConnections } from "@/lib/canvas/model";
import { isEquipment, objectClass } from "@/lib/canvas/taxonomy";
import {
  ASSISTANT_CONTEXT_END,
  ASSISTANT_CONTEXT_START,
} from "@/lib/responses/workspace-context";

export {
  ASSISTANT_CONTEXT_END,
  ASSISTANT_CONTEXT_START,
  stripWorkspaceContext,
} from "@/lib/responses/workspace-context";

interface ClassCount {
  readonly label: string;
  readonly count: number;
  readonly equipment: boolean;
}

interface RelatedEquipment {
  readonly id: string;
  readonly kind: string;
  readonly hops: number;
}

/**
 * The engineering identity of the selection, from the workspace plant register.
 *
 * This is what lets a question be about "FCV-1012 on 6\"-MS-1001-D1B" instead of "the
 * symbol at 1632, 964". The identifiers are simulated, and the rendered context says so,
 * so the agent can use them to talk about the plant without presenting them as printed.
 */
export interface SemanticContext {
  readonly hierarchy: string;
  readonly asset?: {
    readonly tag: string;
    readonly name: string;
    readonly description: string;
    readonly status: string;
    readonly loop?: string;
    readonly loopPartner?: string;
    readonly lines: readonly string[];
    readonly joined: readonly {
      readonly tag: string;
      readonly name: string;
      readonly hops: number;
    }[];
    readonly failureModes: readonly string[];
  };
  /** Set when the selection is part of a pipe run rather than a piece of equipment. */
  readonly line?: {
    readonly number: string;
    readonly assets: readonly string[];
  };
}

/**
 * Deterministic UI context supplied with every canvas question.
 *
 * These values help the agent locate evidence; they are never a substitute for opening the
 * corpus artifacts. Keeping the object typed and immutable prevents one interaction path
 * from silently receiving less context than another.
 */
export interface CanvasAssistantContext {
  readonly drawingPath: string;
  readonly topologyPath: string;
  readonly directed: boolean;
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly classCounts: readonly ClassCount[];
  readonly selected: {
    readonly id: string;
    readonly kind: string;
    readonly className: string;
    readonly classDescription: string;
    readonly printedTag?: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly incidentConnections: number;
    readonly solidConnections: number;
    readonly nonSolidConnections: number;
    readonly unstyledConnections: number;
    readonly reachableObjects: number;
    readonly directGraphNeighbours: readonly string[];
    readonly relatedEquipment: readonly RelatedEquipment[];
  };
  readonly semantic?: SemanticContext;
}

/**
 * Build canvas context in O(V + E) time and O(V + E) temporary space.
 *
 * A single adjacency construction serves both reachability and equipment-neighbour search.
 * No pairwise scan is used, so large user-controlled drawings do not degrade to O(V^2).
 */
export function buildCanvasAssistantContext(
  drawing: CanvasDrawing,
  selected: DrawingNode,
  printedTag?: string,
  semantic?: SemanticContext,
): CanvasAssistantContext {
  const counts = new Map<string, number>();
  for (const node of drawing.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  let incidentConnections = 0;
  let solidConnections = 0;
  let nonSolidConnections = 0;
  let unstyledConnections = 0;
  const directGraphNeighbours = new Set<string>();

  for (const edge of drawing.edges) {
    const outgoing = edge.source === selected.id;
    const incoming = edge.target === selected.id;
    if (!outgoing && !incoming) continue;

    incidentConnections += 1;
    if (edge.style === "solid") solidConnections += 1;
    else if (edge.style === "non-solid") nonSolidConnections += 1;
    else unstyledConnections += 1;

    const neighbour = outgoing ? edge.target : edge.source;
    directGraphNeighbours.add(neighbour);
  }

  const nodeById = new Map(drawing.nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
  const reachable = traceConnections(adjacency, selected.id);
  const relatedEquipment = equipmentNeighbours(
    adjacency,
    (id) => isEquipment(nodeById.get(id)?.kind ?? ""),
    selected.id,
  ).map(({ id, hops }) => ({ id, hops, kind: nodeById.get(id)?.kind ?? "unknown" }));
  const classification = objectClass(selected.kind);

  return {
    drawingPath: drawing.imagePath,
    topologyPath: drawing.source,
    directed: drawing.directed,
    width: drawing.width,
    height: drawing.height,
    nodeCount: drawing.nodes.length,
    edgeCount: drawing.edges.length,
    classCounts: [...counts.entries()]
      .map(([label, count]) => ({ label, count, equipment: isEquipment(label) }))
      .sort(
        (left, right) => right.count - left.count || left.label.localeCompare(right.label),
      ),
    selected: {
      id: selected.id,
      kind: selected.kind,
      className: classification.name,
      classDescription: classification.description,
      ...(printedTag ? { printedTag } : {}),
      x: selected.x,
      y: selected.y,
      width: selected.width,
      height: selected.height,
      incidentConnections,
      solidConnections,
      nonSolidConnections,
      unstyledConnections,
      reachableObjects: Math.max(0, reachable.size - 1),
      directGraphNeighbours: [...directGraphNeighbours],
      relatedEquipment,
    },
    ...(semantic ? { semantic } : {}),
  };
}

/**
 * Append bounded, deterministic workspace metadata to a user question.
 *
 * The footer explicitly says it is navigation context, so the model still has to inspect
 * the corpus before making an engineering claim. The visible transcript removes this exact
 * delimited suffix with {@link stripWorkspaceContext}; arbitrary user text is untouched.
 */
export function withWorkspaceContext(
  question: string,
  context: CanvasAssistantContext,
  extra: readonly string[] = [],
): string {
  const visibleClasses = context.classCounts.slice(0, 100);
  const classInventory = visibleClasses
    .map(
      ({ label, count, equipment }) =>
        `${label}=${count} (${equipment ? "equipment/instrument" : "drawing apparatus"})`,
    )
    .join(", ");
  const omittedClasses = context.classCounts.length - visibleClasses.length;
  const related = context.selected.relatedEquipment
    .map(({ id, kind, hops }) => `${id} (${objectClass(kind).name}, ${hops} graph hops)`)
    .join(", ");

  const lines = [
    ASSISTANT_CONTEXT_START,
    "Workspace navigation context only; verify engineering claims with corpus tools.",
    `Drawing: ${context.drawingPath} (${context.width}x${context.height} px)`,
    `Topology: ${context.topologyPath} (${context.directed ? "directed" : "undirected"}; ${context.nodeCount} nodes; ${context.edgeCount} edges)`,
    `Detected classes: ${classInventory || "none"}${omittedClasses > 0 ? ` (${omittedClasses} more classes omitted from UI context)` : ""}`,
    `Selected source node: ${context.selected.id}`,
    `Selected class: ${context.selected.className} [${context.selected.kind}]`,
    `General class meaning: ${context.selected.classDescription}`,
    ...(context.selected.printedTag
      ? [`Printed tag previously read from the drawing: ${context.selected.printedTag}`]
      : ["Printed tag: not yet read from the drawing"]),
    `Incident graph edges: ${context.selected.incidentConnections} (${context.selected.solidConnections} solid, ${context.selected.nonSolidConnections} non-solid, ${context.selected.unstyledConnections} unstyled)`,
    `Direct graph neighbours: ${boundedList(context.selected.directGraphNeighbours, 80)}`,
    `Reachable graph objects: ${context.selected.reachableObjects}`,
    `Nearest equipment/instruments through drafting nodes: ${related || "none"}`,
    "Do not infer physical flow direction from graph edge order unless the corpus establishes it.",
    ...semanticLines(context.semantic, context.selected.id, context.topologyPath),
    ...extra,
    ASSISTANT_CONTEXT_END,
  ];
  return `${question.trim()}\n\n${lines.join("\n")}`;
}

/** Render a bounded list and say when values were omitted. */
function boundedList(values: readonly string[], limit: number): string {
  if (values.length === 0) return "none";
  const visible = values.slice(0, limit).join(", ");
  const omitted = values.length - limit;
  return omitted > 0 ? `${visible} (${omitted} more omitted from UI context)` : visible;
}

/**
 * Render the register view of the selection.
 *
 * The two instruction lines are the point of it. The first lets the agent answer in the
 * vocabulary an engineer uses; the second keeps it honest about where that vocabulary came
 * from, so a simulated tag is never reported as though it were read off the sheet.
 */
function semanticLines(
  semantic: SemanticContext | undefined,
  sourceNode: string,
  topologyPath: string,
): string[] {
  if (!semantic) return [];
  const lines = [`Plant location (workspace register): ${semantic.hierarchy}`];
  const { asset, line } = semantic;
  if (asset) {
    lines.push(
      `Selected asset: ${asset.tag} — ${asset.name}; status ${asset.status}`,
      `Asset role: ${asset.description}`,
    );
    if (asset.loop) {
      lines.push(
        `Control loop ${asset.loop}${asset.loopPartner ? ` with ${asset.loopPartner}` : ""}`,
      );
    }
    if (asset.lines.length) lines.push(`On line(s): ${boundedList(asset.lines, 12)}`);
    lines.push(
      `Joined equipment: ${
        asset.joined.length
          ? boundedList(
              asset.joined.map((j) => `${j.tag} ${j.name} (${j.hops} hops)`),
              40,
            )
          : "none"
      }`,
    );
    if (asset.failureModes.length) {
      lines.push(
        `ISO 14224 failure modes for this class: ${asset.failureModes.join(", ")}`,
      );
    }
  }
  if (line) {
    lines.push(
      `Selected pipe run: line ${line.number}, joining ${line.assets.length} assets: ${boundedList(line.assets, 40)}`,
    );
  }
  // Without the anchor, an agent told only that a tag is simulated goes looking for it on the
  // drawing, fails, and opens its answer with "I could not locate TCV-1028" — true, and no
  // use to anyone. The component is not missing; it is a known graph node wearing a
  // workspace name, and the agent should find it the way the workspace does.
  lines.push(
    `The selected component is source node ${sourceNode} in ${topologyPath}. Locate it by that node id with the graph tools. Its workspace tag is simulated and is not printed on the drawing, so do not search the drawing for it and do not report it as missing.`,
    "If the drawing shows a printed tag at that symbol, give the printed tag as the real designation and the workspace tag as an alias.",
    "Refer to components by tag, name and line number. Do not describe a component by its pixel position.",
    "Workspace tags, loop and line numbers are simulated identifiers mapped to source nodes. Say so once when you rely on them; do not repeat the caveat throughout.",
  );
  return lines;
}
