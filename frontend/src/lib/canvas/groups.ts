/**
 * Functional groups for the object browser, named the way ISA-5.1 names what a symbol does.
 *
 * The corpus classifies symbols by how they are drawn — "instrumentation", "valve", "tank",
 * "connector". An engineer filters by function: transmitters apart from local gauges, control
 * valves apart from manual isolation valves, exchangers apart from drums. The register already
 * holds that distinction per tag; this module groups by it, and folds the drafting apparatus
 * (connectors, crossings, arrows, frames) into one group so it stays reachable without
 * crowding the equipment.
 */

import type { AssetRecord, PlantRegister } from "./engineering";
import type { DrawingNode } from "./model";

export interface FunctionGroup {
  readonly id: string;
  readonly name: string;
  /** The name as it fits a filter chip. */
  readonly short: string;
  /** A short function code shown beside each row. */
  readonly code: string;
}

export const GROUPS: readonly FunctionGroup[] = [
  {
    id: "transmitter",
    name: "Transmitters",
    short: "Transmitters",
    code: "TX",
  },
  {
    id: "indicator",
    name: "Indicators & gauges",
    short: "Gauges",
    code: "IND",
  },
  {
    id: "control-valve",
    name: "Control valves",
    short: "Control valves",
    code: "CV",
  },
  {
    id: "hand-valve",
    name: "Hand valves",
    short: "Hand valves",
    code: "HV",
  },
  {
    id: "safety-valve",
    name: "Relief valves",
    short: "Relief valves",
    code: "PSV",
  },
  {
    id: "exchanger",
    name: "Heat exchangers",
    short: "Exchangers",
    code: "HX",
  },
  {
    id: "vessel",
    name: "Vessels & drums",
    short: "Vessels",
    code: "VSL",
  },
  { id: "pump", name: "Pumps", short: "Pumps", code: "PMP" },
  {
    id: "off-page",
    name: "Off-page connectors",
    short: "Off-page",
    code: "OPC",
  },
  {
    id: "piping",
    name: "Piping & drafting",
    short: "Piping",
    code: "PIPE",
  },
];

const BY_ID = new Map(GROUPS.map((group) => [group.id, group]));

function groupIdOf(asset: AssetRecord | undefined): string {
  if (!asset) return "piping";
  if (asset.category === "instrument") {
    return /Transmitter$/.test(asset.name) ? "transmitter" : "indicator";
  }
  return asset.category;
}

export function groupOf(node: DrawingNode, register: PlantRegister): FunctionGroup {
  return BY_ID.get(groupIdOf(register.assets.get(node.id))) ?? BY_ID.get("piping")!;
}

/** Groups present on a sheet with their counts, in the fixed order above. O(V). */
export function groupCounts(
  nodes: readonly DrawingNode[],
  register: PlantRegister,
): readonly { readonly group: FunctionGroup; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const id = groupIdOf(register.assets.get(node.id));
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return GROUPS.filter((group) => counts.has(group.id)).map((group) => ({
    group,
    count: counts.get(group.id)!,
  }));
}
