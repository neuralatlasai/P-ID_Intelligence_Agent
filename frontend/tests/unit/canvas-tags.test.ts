import { describe, expect, it } from "vitest";

import {
  assignTags,
  parseTagSweep,
  regionAround,
  tagRegionContext,
  tagSweepQuestion,
} from "@/lib/canvas/tags";
import type { DrawingNode } from "@/lib/canvas/model";

/**
 * These tests guard the one place in the product where model-authored text becomes a label
 * printed on a drawing. Everything else the agent says arrives inside an answer the reader
 * can weigh; a tag rendered beside a valve looks like it was read off the sheet, so the
 * parser has to be the thing that refuses anything it cannot justify.
 */

const WIDTH = 2604;
const HEIGHT = 1744;

function node(id: string, x: number, y: number, kind = "valve"): DrawingNode {
  return { id, kind, x, y, width: 20, height: 20, positioned: true };
}

describe("regionAround", () => {
  it("centres a window on the point", () => {
    expect(regionAround(1000, 800, WIDTH, HEIGHT)).toEqual({
      x: 650,
      y: 500,
      width: 700,
      height: 600,
    });
  });

  it("keeps the window on the sheet near an edge", () => {
    const region = regionAround(10, 10, WIDTH, HEIGHT);

    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    expect(region.width).toBe(700);
  });

  it("never asks for more than the sheet has", () => {
    const region = regionAround(50, 50, 300, 200);

    expect(region).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});

describe("tagSweepQuestion", () => {
  it("names the component and the sheet, and no coordinates", () => {
    const question = tagSweepQuestion("FCV-1012", "0.png");

    expect(question).toContain("FCV-1012");
    expect(question).toContain("0.png");
    // A position in the visible question is what taught answers to describe components by
    // where they are drawn.
    expect(question).not.toMatch(/[xy]=\d|\d+\s*px/);
    expect(question.split("\n")).toHaveLength(1);
  });
});

describe("tagRegionContext", () => {
  it("carries the region and the offset rule for the hidden context", () => {
    const lines = tagRegionContext("area/PID-1.png", "area/PID-1.graphml", {
      x: 400,
      y: 300,
      width: 700,
      height: 600,
    });
    const text = lines.join("\n");

    expect(text).toContain("render_drawing_region");
    expect(text).toContain("x=400, y=300, width=700, height=600");
    // The crop has its own origin; without the offset the tags land 400px left, 300px up.
    expect(text).toContain("400, 300 offset");
  });
});

describe("parseTagSweep", () => {
  it("reads the tag lines and ignores the prose around them", () => {
    const answer = [
      "Answer",
      "I opened the drawing and read across the sheet.",
      "",
      "TAGS",
      "CV-38148 | 1204 | 878",
      "- RV-54473 | 300 | 1500",
      "**OR-31559** | 900.5 | 410.25",
      "",
      "Uncertainty",
      "Several tags in the lower right are too small to read at this resolution.",
    ].join("\n");

    expect(parseTagSweep(answer, WIDTH, HEIGHT)).toEqual([
      { tag: "CV-38148", x: 1204, y: 878 },
      { tag: "RV-54473", x: 300, y: 1500 },
      { tag: "OR-31559", x: 900.5, y: 410.25 },
    ]);
  });

  it("drops text that is not shaped like a plant tag", () => {
    // A sheet number, a note reference and a bare word all reach the parser when the model
    // is loose about what counts as a tag. None of them belong on a symbol.
    const answer = [
      "NOTE | 100 | 100",
      "5 | 200 | 200",
      "SHEET1 | 300 | 300",
      "PI-2101A | 400 | 400",
    ].join("\n");

    expect(parseTagSweep(answer, WIDTH, HEIGHT)).toEqual([
      { tag: "PI-2101A", x: 400, y: 400 },
    ]);
  });

  it("drops coordinates that are not on the sheet", () => {
    const answer = [`FCV-1 | ${WIDTH + 1} | 10`, "FCV-2 | 10 | -4", "FCV-3 | 10 | 10"].join(
      "\n",
    );

    expect(parseTagSweep(answer, WIDTH, HEIGHT).map((t) => t.tag)).toEqual(["FCV-3"]);
  });

  it("keeps the first reading of a repeated tag", () => {
    const answer = ["TI-2210 | 10 | 10", "TI-2210 | 900 | 900"].join("\n");

    expect(parseTagSweep(answer, WIDTH, HEIGHT)).toEqual([
      { tag: "TI-2210", x: 10, y: 10 },
    ]);
  });

  it("returns nothing for an answer that contains no tag lines", () => {
    const answer = "I could not open the drawing, so I have no tags to report.";

    expect(parseTagSweep(answer, WIDTH, HEIGHT)).toEqual([]);
  });

  it("bounds a runaway answer", () => {
    const answer = Array.from(
      { length: 900 },
      (_, index) => `AB-${index + 1000} | ${index % 2000} | 10`,
    ).join("\n");

    expect(parseTagSweep(answer, WIDTH, HEIGHT).length).toBe(400);
  });
});

describe("assignTags", () => {
  it("attaches each tag to the object it is printed on", () => {
    const nodes = [node("valve1", 100, 100), node("valve2", 900, 900)];
    const placed = assignTags(nodes, [
      { tag: "CV-1", x: 110, y: 104 },
      { tag: "CV-2", x: 880, y: 900 },
    ]);

    expect(placed.get("valve1")?.tag).toBe("CV-1");
    expect(placed.get("valve2")?.tag).toBe("CV-2");
  });

  it("refuses a tag that is nowhere near an object", () => {
    // The alternative is printing a real-looking designation on the wrong equipment, which
    // is the single worst thing this feature could do.
    const nodes = [node("valve1", 100, 100)];

    expect(assignTags(nodes, [{ tag: "CV-9", x: 2000, y: 1500 }]).size).toBe(0);
  });

  it("gives a contested tag to the nearer object", () => {
    const nodes = [node("valve1", 100, 100), node("valve2", 160, 100)];
    const placed = assignTags(nodes, [{ tag: "CV-1", x: 150, y: 100 }]);

    expect(placed.get("valve2")?.tag).toBe("CV-1");
    expect(placed.has("valve1")).toBe(false);
  });

  it("never puts two tags on one object or one tag on two objects", () => {
    const nodes = [node("valve1", 100, 100), node("valve2", 130, 100)];
    const placed = assignTags(nodes, [
      { tag: "CV-1", x: 100, y: 100 },
      { tag: "CV-2", x: 132, y: 100 },
    ]);

    expect([...placed.values()].map((entry) => entry.tag).sort()).toEqual(["CV-1", "CV-2"]);
    expect(placed.size).toBe(2);
  });

  it("skips objects the graph could not place", () => {
    const unpositioned: DrawingNode = {
      id: "valve9",
      kind: "valve",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      positioned: false,
    };

    expect(assignTags([unpositioned], [{ tag: "CV-1", x: 0, y: 0 }]).size).toBe(0);
  });
});
