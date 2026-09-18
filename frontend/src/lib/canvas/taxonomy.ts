/**
 * The vocabulary of the source graphs, named the way an engineer would name it.
 *
 * A node in the corpus GraphML carries exactly two things: a class label and a bounding box
 * in the drawing's pixel space. The identifier is the class plus an ordinal — `valve14`,
 * `instrumentation3` — assigned by whatever extracted the graph. It is not a plant tag, and
 * the file contains no plant tag anywhere.
 *
 * So this module does one thing and refuses another.
 *
 * It **translates** the ten raw labels into the terms used on a P&ID, with a description of
 * what each class is, because "instrumentation14" in a list tells an engineer nothing while
 * "Instrument 14 — measurement or control device" tells them what they are looking at.
 *
 * It does **not** manufacture a tag. `PMP-001` rendered next to a symbol looks exactly like
 * a real designation and would be read as one; an engineer would take it to the field, and
 * nothing in the source supports it. The printed tags exist — they are drawn on the raster
 * and written in the accompanying documents — and reading them is the agent's job, with the
 * drawing in front of it. That is what {@link tagQuestion} asks for.
 */

/** The classes the extractor emits. Anything outside this set is handled as unknown. */
export const CLASS_LABELS = [
  "valve",
  "instrumentation",
  "pump",
  "tank",
  "inlet/outlet",
  "connector",
  "crossing",
  "arrow",
  "general",
  "background",
] as const;

export type ClassLabel = (typeof CLASS_LABELS)[number];

export interface ObjectClass {
  /** The label exactly as it appears in the GraphML. */
  readonly label: string;
  /** What the class is called on a drawing. */
  readonly name: string;
  /** Three or four letters for a dense column. */
  readonly abbreviation: string;
  /** What the symbol represents, in one line. */
  readonly description: string;
  /**
   * Whether the class is process equipment rather than drafting apparatus.
   *
   * A connector or a line crossing is how the drawing is *drawn*, not something that exists
   * in the plant, and a list that mixes the two is unusable: the OPEN100 sheet has 437
   * objects, of which 82 are equipment and instruments and most of the rest are connectors.
   */
  readonly equipment: boolean;
}

const UNKNOWN: ObjectClass = {
  label: "unknown",
  name: "Unrecognised symbol",
  abbreviation: "UNK",
  description: "A class this build does not recognise. Shown as extracted, uninterpreted.",
  equipment: false,
};

/**
 * The translation table.
 *
 * Descriptions state what the symbol class means on a P&ID in general. They do not describe
 * the specific item: whether a given valve is a globe valve on cooling water is a question
 * about this drawing, and only the drawing can answer it.
 */
const CLASSES: Readonly<Record<string, ObjectClass>> = {
  valve: {
    label: "valve",
    name: "Valve",
    abbreviation: "VLV",
    description: "Isolation, control or relief element in a process line.",
    equipment: true,
  },
  instrumentation: {
    label: "instrumentation",
    name: "Instrument",
    abbreviation: "INST",
    description: "Measurement, indication or control device — an ISA balloon or symbol.",
    equipment: true,
  },
  pump: {
    label: "pump",
    name: "Pump",
    abbreviation: "PMP",
    description: "Rotating equipment that moves fluid, shown with its driver.",
    equipment: true,
  },
  tank: {
    label: "tank",
    name: "Vessel or tank",
    abbreviation: "VES",
    description: "Storage or process vessel, drum, or tank.",
    equipment: true,
  },
  "inlet/outlet": {
    label: "inlet/outlet",
    name: "Inlet or outlet",
    abbreviation: "I/O",
    description: "Where a line enters or leaves the sheet — an off-page connection.",
    equipment: true,
  },
  connector: {
    label: "connector",
    name: "Line connector",
    abbreviation: "CONN",
    description: "A junction between line segments. Drafting apparatus, not equipment.",
    equipment: false,
  },
  crossing: {
    label: "crossing",
    name: "Line crossing",
    abbreviation: "XING",
    description: "Two lines that cross the page without joining.",
    equipment: false,
  },
  arrow: {
    label: "arrow",
    name: "Flow arrow",
    abbreviation: "ARR",
    description: "Direction marker drawn on a line.",
    equipment: false,
  },
  general: {
    label: "general",
    name: "Unclassified symbol",
    abbreviation: "GEN",
    description: "A symbol the extractor detected but did not classify.",
    equipment: false,
  },
  background: {
    label: "background",
    name: "Drawing frame",
    abbreviation: "FRM",
    description: "Border, grid reference or title block.",
    equipment: false,
  },
};

/** Look up a class, falling back to an explicitly unrecognised one. */
export function objectClass(label: string): ObjectClass {
  return CLASSES[label] ?? UNKNOWN;
}

/** The classes drawn on the overlay and listed as equipment, in reading order. */
export const EQUIPMENT_CLASSES: readonly ObjectClass[] = CLASS_LABELS.map(
  objectClass,
).filter((entry) => entry.equipment);

/** Whether a node's class is process equipment rather than drafting apparatus. */
export function isEquipment(label: string): boolean {
  return objectClass(label).equipment;
}

/**
 * Split a source identifier into its class and its ordinal.
 *
 * `instrumentation14` becomes `instrumentation` and `14`. An identifier that does not follow
 * the pattern keeps its whole text as the stem and has no ordinal, which is the correct
 * outcome for a graph produced by a different exporter.
 */
export function splitIdentifier(id: string): { stem: string; ordinal: string | null } {
  const match = /^(.*?)(\d+)$/.exec(id);
  if (!match || !match[1]) {
    return { stem: id, ordinal: null };
  }
  return { stem: match[1], ordinal: match[2] ?? null };
}

/**
 * The name to show for a node.
 *
 * `Instrument 14`, not `instrumentation14` and not `PI-2101A`. The first is what the source
 * says, read properly; the third would be a designation nobody wrote down.
 */
export function displayName(id: string, label: string): string {
  const { ordinal } = splitIdentifier(id);
  const { name } = objectClass(label);
  return ordinal ? `${name} ${ordinal}` : name;
}

/** Line style, as recorded on the edge. */
export function lineStyle(edgeLabel: string | undefined): {
  readonly name: string;
  readonly note: string;
} {
  if (edgeLabel === "non-solid") {
    return {
      name: "Dashed line",
      note: "Drawn dashed. On a P&ID that conventionally marks an instrument or signal line; the source records the style, not the service.",
    };
  }
  return {
    name: "Solid line",
    note: "Drawn solid. On a P&ID that conventionally marks process piping; the source records the style, not the service.",
  };
}

/**
 * The question that resolves a source object to its printed tag.
 *
 * The bounding box is included because it is the only thing that can point the agent at the
 * right part of a 2604 × 1744 sheet, and the instruction to report nothing when nothing is
 * legible is the part that keeps the answer worth having.
 */
export function tagQuestion(params: {
  readonly id: string;
  readonly label: string;
  readonly imagePath: string;
  readonly source: string;
  readonly box: { x: number; y: number; width: number; height: number };
}): string {
  const { id, label, imagePath, source, box } = params;
  const left = Math.round(box.x - box.width / 2);
  const top = Math.round(box.y - box.height / 2);
  return [
    `Open the drawing ${imagePath} and read the equipment tag printed next to the ${objectClass(label).name.toLowerCase()} symbol at approximately x=${Math.round(box.x)}, y=${Math.round(box.y)} pixels (bounding box ${left},${top} to ${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}, origin top-left).`,
    "",
    `That symbol is node ${id} in ${source}, which records only its class and position — the source carries no tag, so the tag must come from the drawing itself or from a corpus document.`,
    "",
    "Report the tag exactly as printed, the line or service it sits on if the drawing states it, and the equipment it connects to. If the text is not legible at that location, say so and do not offer a tag.",
  ].join("\n");
}
