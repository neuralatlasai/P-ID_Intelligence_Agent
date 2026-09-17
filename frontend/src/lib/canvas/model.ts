import fixture from "../../../public/demo/main-steam.json";

export interface DrawingNode {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly positioned?: boolean;
}

/**
 * One connection between two objects.
 *
 * `style` is how the line is drawn in the source — `solid` or `non-solid`. It is the only
 * attribute the graph records about a connection beyond its endpoints, and it is what
 * separates a piping run from a signal line on the sheet. An edge whose source recorded no
 * style has none here; a default would assert something the drawing never said.
 */
export interface DrawingEdge {
  readonly source: string;
  readonly target: string;
  readonly style?: string;
}

export interface CanvasDrawing {
  readonly source: string;
  readonly imagePath: string;
  readonly width: number;
  readonly height: number;
  readonly directed: boolean;
  readonly nodes: readonly DrawingNode[];
  readonly edges: readonly DrawingEdge[];
  readonly unpositioned?: number;
}

/** Validate source geometry at the browser boundary before allocating render state. */
export function parseDrawing(value: unknown): CanvasDrawing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.source !== "string" ||
    !data.source ||
    data.source.length > 1024 ||
    typeof data.imagePath !== "string" ||
    !data.imagePath ||
    data.imagePath.length > 1024 ||
    typeof data.directed !== "boolean" ||
    typeof data.width !== "number" ||
    typeof data.height !== "number" ||
    !Number.isSafeInteger(data.width) ||
    !Number.isSafeInteger(data.height) ||
    data.width <= 0 ||
    data.height <= 0 ||
    data.width * data.height > 24_000_000 ||
    !Array.isArray(data.nodes) ||
    !Array.isArray(data.edges) ||
    data.nodes.length === 0 ||
    data.nodes.length > 2000 ||
    data.edges.length > 4000
  )
    return undefined;
  const ids = new Set<string>();
  for (const node of data.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      node.id.length > 1024 ||
      ids.has(node.id) ||
      typeof node.kind !== "string" ||
      node.kind.length > 1024 ||
      ![node.x, node.y, node.width, node.height].every(
        (number) => typeof number === "number" && Number.isFinite(number),
      ) ||
      node.width < 0 ||
      node.height < 0 ||
      node.x < 0 ||
      node.y < 0 ||
      node.x > data.width ||
      node.y > data.height ||
      node.x - node.width / 2 < 0 ||
      node.x + node.width / 2 > data.width ||
      node.y - node.height / 2 < 0 ||
      node.y + node.height / 2 > data.height ||
      (node.positioned !== undefined && typeof node.positioned !== "boolean")
    )
      return undefined;
    ids.add(node.id);
  }
  for (const edge of data.edges) {
    if (
      !edge ||
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      (edge.style !== undefined &&
        (typeof edge.style !== "string" || edge.style.length > 64))
    )
      return undefined;
  }
  if (
    data.unpositioned !== undefined &&
    (typeof data.unpositioned !== "number" ||
      !Number.isSafeInteger(data.unpositioned) ||
      data.unpositioned < 0 ||
      data.unpositioned > data.nodes.length)
  )
    return undefined;
  return value as CanvasDrawing;
}

export const drawing = fixture;

/** Build once in O(V + E); adjacency avoids repeated edge scans during selection. */
export function buildAdjacency(
  nodes: readonly DrawingNode[],
  edges: readonly DrawingEdge[],
  directed = false,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const { source, target } of edges) {
    if (!index.has(source) || !index.has(target)) continue;
    index.get(source)?.push(target);
    if (!directed && source !== target) index.get(target)?.push(source);
  }
  return index;
}

/**
 * Breadth-first traversal is O(V + E), including cyclic/disconnected drawings.
 * A head index avoids Array.shift's repeated O(V) compaction. Adjacency preserves
 * declared edge direction, which must never be presented as physical causality.
 */
export function traceConnections(
  index: ReadonlyMap<string, readonly string[]>,
  start: string,
): ReadonlyMap<string, number> {
  if (!index.has(start)) return new Map();
  const distances = new Map([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const neighbor of index.get(current) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distances.get(current)! + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

/** Bounded, deterministic UI telemetry; dimensionless and not a physical process model. */
export function demoSignal(tick: number, setting: number): number {
  const time = Number.isFinite(tick) ? Math.max(0, tick) % 3600 : 0;
  const target = Number.isFinite(setting) ? Math.max(0, Math.min(100, setting)) : 50;
  return Math.max(0, Math.min(100, target + 3 * Math.sin(time / 5) + Math.sin(time / 2)));
}

/**
 * The equipment an object is actually joined to.
 *
 * Raw graph adjacency answers the wrong question. A valve's neighbours in the extracted
 * topology are line connectors and crossings — this sheet has 225 connectors and 71
 * crossings against 82 pieces of equipment — so "what is this connected to" comes back as
 * "Line connector 216", which is how the drawing was *drawn*, not what is in the plant.
 *
 * So the search walks through the drafting apparatus and stops at the first real item on
 * each path: a breadth-first traversal that expands a node only when it is not equipment.
 * The result is what an engineer means by connected — the valve downstream, the vessel the
 * line runs into — with the number of graph hops kept so a long, indirect route can be told
 * apart from a direct one.
 *
 * O(V + E): every node and edge is considered at most once.
 *
 * @param index - Adjacency from {@link buildAdjacency}.
 * @param isEquipment - Whether a node id names process equipment rather than apparatus.
 * @param start - The object to search out from.
 * @param limit - Maximum neighbours to return, newest-shortest first.
 */
export function equipmentNeighbours(
  index: ReadonlyMap<string, readonly string[]>,
  isEquipment: (id: string) => boolean,
  start: string,
  limit = 60,
): readonly { id: string; hops: number }[] {
  if (!index.has(start)) return [];

  const found: { id: string; hops: number }[] = [];
  const seen = new Set([start]);
  const queue: { id: string; hops: number }[] = [{ id: start, hops: 0 }];

  for (let head = 0; head < queue.length && found.length < limit; head += 1) {
    const current = queue[head]!;
    for (const next of index.get(current.id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const hops = current.hops + 1;
      if (isEquipment(next)) {
        // Equipment terminates this path: whatever lies beyond it is connected to *it*,
        // not to the object the search started from.
        found.push({ id: next, hops });
        // The bound has to hold here as well as in the outer loop: one hub node can have
        // more neighbours than the limit, and they all arrive in a single pass.
        if (found.length >= limit) break;
        continue;
      }
      queue.push({ id: next, hops });
    }
  }

  return found;
}
