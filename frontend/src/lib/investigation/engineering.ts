import { buildAdjacency, type CanvasDrawing } from "@/lib/canvas/model";
import { isEquipment } from "@/lib/canvas/taxonomy";

export interface EquipmentPath {
  readonly id: string;
  readonly kind: string;
  readonly path: readonly string[];
}

/** O(V + E) BFS. Stop at equipment; never infer physical flow from graph order. */
export function traceEquipment(
  drawing: CanvasDrawing,
  start: string,
): readonly EquipmentPath[] {
  const nodes = new Map(drawing.nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
  if (!nodes.has(start)) return [];
  const parent = new Map<string, string>([[start, start]]);
  const queue = [start];
  const endpoints: string[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    for (const id of adjacency.get(queue[head]!) ?? []) {
      if (parent.has(id)) continue;
      parent.set(id, queue[head]!);
      const kind = nodes.get(id)!.kind;
      if (isEquipment(kind)) endpoints.push(id);
      else queue.push(id);
    }
  }
  // Explicit output bound limits path materialization to O(60V).
  return endpoints.slice(0, 60).map((id) => {
    const path = [id];
    while (path.at(-1) !== start) path.push(parent.get(path.at(-1)!)!);
    return { id, kind: nodes.get(id)!.kind, path: path.reverse() };
  });
}

export const SIMULATION_VERSION = "normalized-step-v1";
export const SAMPLE_SECONDS = 1;
export const WINDOW_SAMPLES = 61;

/** Demonstration parameters are repeatable per node, never inferred plant parameters. */
export function scenarioProfile(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { baseline: 40 + (hash % 16), tau: 8 + (hash % 17), stepAt: 10 };
}

/** Analytic solution to dy/dt=(target-y)/tau; bounded normalized output, no solver drift. */
export function scenarioValue(id: string, seconds: number, disturbance: number): number {
  const { baseline, tau, stepAt } = scenarioProfile(id);
  const elapsed = Math.max(0, Number.isFinite(seconds) ? seconds - stepAt : 0);
  const amplitude = Number.isFinite(disturbance)
    ? Math.max(-25, Math.min(25, disturbance))
    : 0;
  return baseline + amplitude * (1 - Math.exp(-elapsed / tau));
}

export function scenarioWindow(
  id: string,
  tick: number,
  disturbance: number,
): readonly number[] {
  const end = Math.max(0, Math.floor(tick));
  const start = Math.max(0, end - WINDOW_SAMPLES + 1);
  return Array.from({ length: end - start + 1 }, (_, index) =>
    scenarioValue(id, start + index, disturbance),
  );
}

export const coordinate = (value: number): string => value.toFixed(2);

/** Display ranges are exercise assumptions, not measurements or equipment design limits. */
export function displayProfile(id: string) {
  if (
    [
      "tank70",
      "instrumentation22",
      "instrumentation42",
      "instrumentation60",
      "instrumentation61",
    ].includes(id)
  )
    return { label: "Temperature response", unit: "°C", lower: 240, span: 120 };
  if (["tank67", "instrumentation15"].includes(id))
    return { label: "Pressure response", unit: "bar", lower: 0, span: 100 };
  return { label: "Actuator response", unit: "%", lower: 0, span: 100 };
}

export function displayValue(id: string, normalized: number): number {
  const profile = displayProfile(id);
  return profile.lower + (normalized * profile.span) / 100;
}
