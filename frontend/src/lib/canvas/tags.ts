/**
 * Plant tags read off the drawing.
 *
 * The topology graph records a class and a bounding box per object and nothing else. The
 * real designations — `CV-38148`, `RV-54473`, `PI-2101A` — are printed on the raster, which
 * makes reading them a job for the agent: it has the drawing, and it is the only component
 * in this system allowed to interpret one.
 *
 * So the flow is: ask the agent for every legible tag together with where it sits, then
 * attach each tag to the nearest object the graph already knows about. Both halves matter.
 * The agent supplies the text; the graph supplies the identity. Nothing here invents a tag,
 * and a tag that cannot be placed on a known object is discarded rather than displayed
 * next to a guess.
 */

import type { DrawingNode } from "./model";

/** A tag the agent reported, with where it said the text sits on the sheet. */
export interface ReadTag {
  readonly tag: string;
  readonly x: number;
  readonly y: number;
}

/** A tag that has been matched to an object in the graph. */
export interface TagAssignment {
  readonly tag: string;
  /** Distance in source pixels between the reported text and the object's centre. */
  readonly distance: number;
}

/** The region of the sheet one read covers, in source pixels. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A window around a point, clamped to the sheet.
 *
 * One window per read rather than a whole-sheet sweep. A sweep is a dozen magnified tiles
 * in a single turn, and in practice the run spends its entire tool budget magnifying and
 * ends before it writes an answer — the reader gets nothing. A window is one tool call: it
 * returns in seconds, it names every tag around whatever the engineer is looking at, and
 * reading a second area is another click rather than a restart.
 */
export function regionAround(
  x: number,
  y: number,
  sheetWidth: number,
  sheetHeight: number,
  width = 700,
  height = 600,
): Region {
  const w = Math.min(width, sheetWidth);
  const h = Math.min(height, sheetHeight);
  return {
    x: Math.round(Math.max(0, Math.min(x - w / 2, sheetWidth - w))),
    y: Math.round(Math.max(0, Math.min(y - h / 2, sheetHeight - h))),
    width: Math.round(w),
    height: Math.round(h),
  };
}

/**
 * The request the engineer sees.
 *
 * Named by the component, never by its coordinates. "Read the printed tags around FCV-1012"
 * is a question an engineer would ask; "read the region x=1282, y=664" is an instruction to
 * a tool, and putting it in the transcript made every answer describe components by where
 * they are drawn. The region still reaches the agent — see {@link tagRegionContext} — in
 * the hidden workspace context, which the transcript never shows.
 */
export function tagSweepQuestion(subject: string, sheet: string): string {
  return `Read the printed equipment and instrument tags around ${subject} on ${sheet}.`;
}

/**
 * The machine half of a tag read, for the hidden workspace context.
 *
 * The output format, origin and no-guessing rule are standing instructions in the agent's
 * prompt; this supplies only what varies per request.
 */
export function tagRegionContext(
  imagePath: string,
  source: string,
  region: Region,
): readonly string[] {
  const { x, y, width, height } = region;
  return [
    `Tag read request: call render_drawing_region on ${imagePath} with x=${x}, y=${y}, width=${width}, height=${height}.`,
    `Report positions in the original image's pixels (add the ${x}, ${y} offset back). ${source} records no tags.`,
  ];
}

/** A tag designation: letters, then digits, with dashes or slashes between the parts. */
const TAG_PATTERN = /^[A-Z][A-Z0-9]{0,5}(?:[-/][A-Z0-9]+){1,4}[A-Z]?$/;

/** `TAG | x | y`, tolerant of surrounding list markers, bold and whitespace. */
const LINE_PATTERN =
  /^\s*(?:[-*+]\s*)?\*{0,2}([A-Za-z0-9][A-Za-z0-9\-/.]{2,39})\*{0,2}\s*\|\s*(-?\d{1,6}(?:\.\d+)?)\s*\|\s*(-?\d{1,6}(?:\.\d+)?)\s*$/;

/**
 * Extract the reported tags from an answer.
 *
 * Every line that does not match the format is skipped in silence. That is deliberate: the
 * answer is model-authored text and will contain prose, headings and caveats around the
 * lines, and a parser that tried to salvage them would be inventing the very thing this
 * module exists to avoid.
 *
 * @param answer - The assistant's answer text.
 * @param width - Drawing width in pixels; coordinates outside the sheet are dropped.
 * @param height - Drawing height in pixels.
 */
export function parseTagSweep(
  answer: string,
  width: number,
  height: number,
): readonly ReadTag[] {
  const seen = new Set<string>();
  const tags: ReadTag[] = [];

  for (const line of answer.split("\n")) {
    const match = LINE_PATTERN.exec(line);
    if (!match) continue;

    const tag = (match[1] ?? "").toUpperCase();
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (!TAG_PATTERN.test(tag)) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || y < 0 || x > width || y > height) continue;
    // One tag is one physical item. A repeat is the model listing it twice, not two items.
    if (seen.has(tag)) continue;

    seen.add(tag);
    tags.push({ tag, x, y });
    // A sheet has hundreds of symbols, not thousands of tags; a longer list is a runaway
    // answer rather than a richer reading.
    if (tags.length >= 400) break;
  }

  return tags;
}

/**
 * Attach each reported tag to the object it sits on.
 *
 * Nearest-centre within a radius, greedily by distance, one tag per object. The radius is
 * the point of the whole function: a tag printed halfway across the sheet from any symbol
 * is a reading error or a line label, and attaching it to whatever happened to be closest
 * would put a real-looking designation on the wrong equipment.
 *
 * @param nodes - Objects from the topology graph.
 * @param tags - Tags as reported by the agent.
 * @param radius - Maximum distance, in source pixels, between text and object centre.
 */
export function assignTags(
  nodes: readonly DrawingNode[],
  tags: readonly ReadTag[],
  radius = 110,
): ReadonlyMap<string, TagAssignment> {
  const placed = new Map<string, TagAssignment>();
  const candidates: { nodeId: string; tag: string; distance: number }[] = [];

  for (const tag of tags) {
    for (const node of nodes) {
      if (node.positioned === false) continue;
      const distance = Math.hypot(node.x - tag.x, node.y - tag.y);
      if (distance <= radius) {
        candidates.push({ nodeId: node.id, tag: tag.tag, distance });
      }
    }
  }

  // Closest pairings win, so a tag between two symbols goes to the one it is printed on
  // rather than to whichever was listed first.
  candidates.sort((a, b) => a.distance - b.distance);
  const usedTags = new Set<string>();
  for (const candidate of candidates) {
    if (placed.has(candidate.nodeId) || usedTags.has(candidate.tag)) continue;
    placed.set(candidate.nodeId, { tag: candidate.tag, distance: candidate.distance });
    usedTags.add(candidate.tag);
  }

  return placed;
}
