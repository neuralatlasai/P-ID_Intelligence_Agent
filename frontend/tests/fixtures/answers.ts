/**
 * Representative answers, shaped the way the backend's prompt instructs the agent to write.
 *
 * These are fixtures, not expected outputs: they exist so the projection can be exercised
 * against realistic structure, including the awkward cases — a corpus path containing a
 * space, an engineering tag containing a hyphen, a heading with a parenthetical qualifier.
 */

/** A full answer with every projectable section present. */
export const FULL_ANSWER = [
  "Answer",
  "FCV-2201 is a control valve regulating flow to heat exchanger E-2201.",
  "",
  "Observed (from drawings and documents)",
  "- FCV-2201 is located on line CW-2201-6 — PID2Graph OPEN100/0.graphml",
  "- Connected downstream to E-2201 — 462-Piping-and-Instrumentation-Diagrams.pdf page 3",
  "",
  "Corroborated (across sources)",
  "- Tagged as a flow control valve — PID2Graph OPEN100/1.graphml",
  "",
  "Inferred (from context)",
  "- Modulates to maintain target outlet temperature at E-2201",
  "",
  "Conflicting / Unknown",
  "- Position feedback is not clearly shown in revision A",
  "",
  "Topology / connectivity",
  "P-2101A -> FCV-2201 -> E-2201",
  "",
  "Asset hierarchy",
  "- Cooling water unit",
  "  - E-2201 heat exchanger",
  "    - FCV-2201 control valve",
  "",
  "Impacted assets",
  "- E-2201 — downstream heat exchanger",
  "- P-2101A — upstream pump",
  "",
  "Uncertainty",
  "Alarm configuration was not found in the available documents.",
].join("\n");

/** An answer with no recognised structure at all. */
export const PLAIN_ANSWER = [
  "The drawing shows a cooling water circuit with two pumps and one exchanger.",
  "",
  "Nothing in the corpus states the design pressure.",
].join("\n");

/** An answer that explicitly reports insufficient evidence. */
export const INSUFFICIENT_ANSWER = [
  "Answer",
  "Unknown: the corpus contains no evidence for a vessel tagged V-9999.",
  "",
  "Uncertainty",
  "Insufficient evidence: no drawing, topology file or document mentions V-9999.",
].join("\n");

/** An answer that surfaces a conflict between sources. */
export const CONFLICTING_ANSWER = [
  "Answer",
  "The two sources disagree about the size of LN-1001.",
  "",
  "Conflicting / Unknown",
  '- GraphML indicates LN-1001 is 4"; the revision 04 document says 6".',
].join("\n");
