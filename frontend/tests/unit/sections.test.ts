import { describe, expect, it } from "vitest";

import {
  classifyHeading,
  deriveEvidenceSupport,
  extractAssetHierarchy,
  extractImpactedAssets,
  extractSources,
  extractTopologySteps,
  findSegment,
  splitAnswer,
} from "@/lib/responses/sections";

import {
  CONFLICTING_ANSWER,
  FULL_ANSWER,
  INSUFFICIENT_ANSWER,
  PLAIN_ANSWER,
} from "../fixtures/answers";

/**
 * Answer projection.
 *
 * The four rules the module claims are each asserted here: nothing is lost, nothing is
 * invented, recognition is lexical, and a failure costs a card rather than the answer.
 */

describe("splitAnswer", () => {
  it("reproduces the input exactly when segments are concatenated", () => {
    // This is the invariant that makes projection safe: the renderer walks segments, so
    // if they reconstruct the source, nothing can be hidden by a parse failure.
    for (const answer of [FULL_ANSWER, PLAIN_ANSWER, INSUFFICIENT_ANSWER, ""]) {
      expect(
        splitAnswer(answer)
          .map((segment) => segment.raw)
          .join(""),
      ).toBe(answer);
    }
  });

  it("recognises the evidence vocabulary the backend prompt uses", () => {
    const kinds = splitAnswer(FULL_ANSWER).map((segment) => segment.kind);
    expect(kinds).toContain("observed");
    expect(kinds).toContain("corroborated");
    expect(kinds).toContain("inferred");
    expect(kinds).toContain("conflicting");
    expect(kinds).toContain("topology");
    expect(kinds).toContain("impacted");
  });

  it("degrades to one plain segment when nothing is recognised", () => {
    const segments = splitAnswer(PLAIN_ANSWER);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("other");
    expect(segments[0]?.raw).toBe(PLAIN_ANSWER);
  });

  it("strips the heading from the body but keeps it in raw", () => {
    const observed = findSegment(splitAnswer(FULL_ANSWER), "observed");
    expect(observed?.heading).toBe("Observed (from drawings and documents)");
    expect(observed?.body.startsWith("- FCV-2201")).toBe(true);
    expect(observed?.raw).toContain("Observed (from drawings");
  });
});

describe("classifyHeading", () => {
  it.each([
    ["Observed", "observed"],
    ["Component explained", "component"],
    ["Detections", "detections"],
    ["Engineering context", "engineering_context"],
    ["## Observed", "observed"],
    ["**Observed:**", "observed"],
    ["Observed (from drawings and documents)", "observed"],
    ["CORROBORATED", "corroborated"],
    ["Conflicting / Unknown", "conflicting"],
    ["Topology / connectivity", "topology"],
    ["Impacted assets", "impacted"],
    ["Related equipment", "impacted"],
    ["Asset hierarchy", "assets"],
    ["Uncertainty", "uncertainty"],
    ["Pipeline coverage", "pipeline"],
    ["Evidence", "evidence"],
    ["Answer", "answer"],
  ])("recognises %s", (line, expected) => {
    expect(classifyHeading(line)).toBe(expected);
  });

  it.each([
    ["a list item", "- Observed on drawing 4"],
    ["a numbered item", "1. Observed on drawing 4"],
    [
      "a sentence starting with a keyword",
      "Evidence for this claim comes from three separate drawings and one topology file.",
    ],
    ["an empty line", ""],
    ["prose", "The valve modulates."],
  ])("does not treat %s as a heading", (_label, line) => {
    expect(classifyHeading(line)).toBeNull();
  });
});

describe("extractSources", () => {
  it("reports a path the agent demonstrably opened", () => {
    const sources = extractSources(FULL_ANSWER, ["PID2Graph OPEN100/0.graphml"]);
    const opened = sources.find((s) => s.path === "PID2Graph OPEN100/0.graphml");
    expect(opened?.provenance).toBe("opened");
    expect(opened?.kind).toBe("graphml");
  });

  it("reads a page number stated beside a path", () => {
    const sources = extractSources(FULL_ANSWER);
    const pdf = sources.find((s) => s.kind === "pdf");
    expect(pdf?.page).toBe(3);
  });

  it("never reports a truncated fragment of a path containing spaces", () => {
    // "PID2Graph OPEN100/1.graphml" contains a space. Reporting the tail alone would name
    // a file that does not exist, which is worse than omitting it.
    const sources = extractSources(FULL_ANSWER, []);
    expect(sources.map((s) => s.path)).not.toContain("OPEN100/1.graphml");
    expect(sources.map((s) => s.path)).not.toContain("OPEN100/0.graphml");
  });

  it("resolves a spaced path when a corpus listing confirms it exists", () => {
    const sources = extractSources(FULL_ANSWER, [], ["PID2Graph OPEN100/1.graphml"]);
    const resolved = sources.find((s) => s.path === "PID2Graph OPEN100/1.graphml");
    expect(resolved).toBeDefined();
    expect(resolved?.provenance).toBe("cited");
  });

  it("does not duplicate a path that is both opened and cited", () => {
    const sources = extractSources(FULL_ANSWER, ["PID2Graph OPEN100/0.graphml"]);
    const matches = sources.filter((s) => s.path.endsWith("OPEN100/0.graphml"));
    expect(matches).toHaveLength(1);
  });

  it("drops an absolute path or a traversal, whatever produced it", () => {
    const answer = "See /etc/passwd.png and ../../secret.pdf for details.";
    expect(extractSources(answer)).toEqual([]);
  });

  it("returns nothing for an answer with no references", () => {
    expect(extractSources(PLAIN_ANSWER)).toEqual([]);
  });
});

describe("deriveEvidenceSupport", () => {
  it("reports a conflict when the answer states one", () => {
    expect(deriveEvidenceSupport(splitAnswer(CONFLICTING_ANSWER), CONFLICTING_ANSWER)).toBe(
      "conflicting",
    );
  });

  it("reports insufficiency when the answer states it", () => {
    expect(
      deriveEvidenceSupport(splitAnswer(INSUFFICIENT_ANSWER), INSUFFICIENT_ANSWER),
    ).toBe("insufficient");
  });

  it("reports not assessed when the answer makes no statement", () => {
    // Silence is not support. Defaulting to something reassuring would be the frontend
    // asserting a confidence the answer never claimed.
    expect(deriveEvidenceSupport(splitAnswer(PLAIN_ANSWER), PLAIN_ANSWER)).toBe(
      "not_assessed",
    );
  });

  it("never produces a numeric value", () => {
    const values = [FULL_ANSWER, PLAIN_ANSWER, CONFLICTING_ANSWER, INSUFFICIENT_ANSWER].map(
      (answer) => deriveEvidenceSupport(splitAnswer(answer), answer),
    );
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect(value).not.toMatch(/\d/);
    }
  });
});

describe("extractTopologySteps", () => {
  it("reads an explicitly arrowed path", () => {
    expect(extractTopologySteps(splitAnswer(FULL_ANSWER)).map((s) => s.label)).toEqual([
      "P-2101A",
      "FCV-2201",
      "E-2201",
    ]);
  });

  it("returns nothing when no topology section exists", () => {
    expect(extractTopologySteps(splitAnswer(PLAIN_ANSWER))).toEqual([]);
  });

  it("does not treat adjacent list items as connected", () => {
    // Adjacency is not a relationship. Treating it as one would manufacture edges.
    const answer = "Topology / connectivity\n- P-2101A\n- FCV-2201\n- E-2201";
    expect(extractTopologySteps(splitAnswer(answer))).toEqual([]);
  });
});

describe("extractImpactedAssets", () => {
  it("keeps a hyphenated engineering tag intact", () => {
    // A bare hyphen cannot be the tag/note separator: E-2201 would become "E".
    const assets = extractImpactedAssets(splitAnswer(FULL_ANSWER));
    expect(assets[0]?.tag).toBe("E-2201");
    expect(assets[0]?.note).toBe("downstream heat exchanger");
    expect(assets[1]?.tag).toBe("P-2101A");
  });

  it("accepts an item with no note", () => {
    const answer = "Impacted assets\n- LIC-2203\n- TI-2210";
    expect(extractImpactedAssets(splitAnswer(answer)).map((a) => a.tag)).toEqual([
      "LIC-2203",
      "TI-2210",
    ]);
  });

  it("ignores a tag mentioned only in prose", () => {
    const answer = "Answer\nE-2201 is downstream of FCV-2201.";
    expect(extractImpactedAssets(splitAnswer(answer))).toEqual([]);
  });
});

describe("extractAssetHierarchy", () => {
  it("reads levels from the answer's own indentation", () => {
    const rows = extractAssetHierarchy(splitAnswer(FULL_ANSWER));
    expect(rows.map((r) => r.label)).toEqual([
      "Cooling water unit",
      "E-2201 heat exchanger",
      "FCV-2201 control valve",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("returns nothing when no hierarchy section exists", () => {
    expect(extractAssetHierarchy(splitAnswer(PLAIN_ANSWER))).toEqual([]);
  });
});

describe("failure is local", () => {
  it.each([
    ["empty", ""],
    ["only whitespace", "   \n\n  "],
    ["unterminated markdown", "Answer\n| a | b |\n| --"],
    ["headings with no bodies", "Observed\nCorroborated\nInferred"],
  ])("does not throw on %s", (_label, answer) => {
    const segments = splitAnswer(answer);
    expect(() => {
      extractSources(answer);
      deriveEvidenceSupport(segments, answer);
      extractTopologySteps(segments);
      extractImpactedAssets(segments);
      extractAssetHierarchy(segments);
    }).not.toThrow();
  });
});
