/**
 * Conservative projection of an answer's explicit structure.
 *
 * The backend instructs the agent to write under stable headings and to label every claim
 * with how it is known — observed, corroborated, inferred, conflicting, unknown. This
 * module recognises that structure so the UI can present it well. It does not create it.
 *
 * Four rules hold throughout, and each is covered by a test:
 *
 *  1. **Nothing is lost.** {@link splitAnswer} guarantees that concatenating every
 *     segment's `raw` reproduces the input exactly. A parse that fails to recognise a
 *     heading degrades into one plain segment containing everything.
 *  2. **Nothing is invented.** A card renders only when the answer explicitly contains the
 *     corresponding section. There is no default, no placeholder, and no inference from
 *     naming conventions.
 *  3. **Recognition is lexical.** Headings are matched by text, not meaning. No model is
 *     called and no semantics are derived.
 *  4. **Failure is local.** Every extractor returns an empty result rather than throwing,
 *     so a malformed answer costs a card, never the answer.
 */

/** Sections the projector recognises. `other` covers any heading it does not. */
export type SectionKind =
  | "answer"
  | "component"
  | "detections"
  | "engineering_context"
  | "evidence"
  | "observed"
  | "corroborated"
  | "inferred"
  | "conflicting"
  | "unknown"
  | "sources"
  | "assets"
  | "topology"
  | "revisions"
  | "conflicts"
  | "impacted"
  | "uncertainty"
  | "pipeline"
  | "other";

/**
 * One contiguous piece of the answer.
 *
 * `raw` is the verbatim source text including the heading line and its trailing newline.
 * `body` is the same text with the heading removed, which is what gets rendered as
 * Markdown inside a labelled block.
 */
export interface AnswerSegment {
  readonly kind: SectionKind;
  /** The heading exactly as written, or `null` for text before the first heading. */
  readonly heading: string | null;
  readonly body: string;
  readonly raw: string;
}

/** A corpus artifact the answer refers to, or that the agent demonstrably opened. */
export interface SourceReference {
  /** Corpus-relative path, exactly as it appeared. Never constructed. */
  readonly path: string;
  readonly kind: "png" | "pdf" | "graphml";
  /** One-based page, when the answer stated one next to the path. */
  readonly page?: number;
  /**
   * How this reference is known.
   *
   * `opened` means the agent called a tool with this exact path, which is verified fact
   * taken from persisted tool arguments. `cited` means the path appears in the answer
   * text. The distinction matters: a cited path the agent never opened is worth noticing.
   */
  readonly provenance: "opened" | "cited";
}

/** Categorical evidence support. Never a number — see the confidence policy. */
export type EvidenceSupport =
  "supported" | "partial" | "conflicting" | "insufficient" | "not_assessed";

/** One step in an explicitly stated connectivity path. */
export interface TopologyStep {
  readonly label: string;
}

/** An explicitly stated impacted asset. */
export interface ImpactedAsset {
  readonly tag: string;
  readonly note?: string;
}

/**
 * Heading patterns, in match order.
 *
 * Matching is case-insensitive and tolerant of Markdown heading markers, bold markers,
 * trailing colons and trailing parentheticals — so `## Observed`, `**Observed:**` and
 * `Observed (from drawings and documents)` all resolve to the same kind. Order matters:
 * more specific patterns precede the general ones they would otherwise be shadowed by.
 */
const HEADING_PATTERNS: ReadonlyArray<readonly [SectionKind, RegExp]> = [
  ["component", /^component explained\b|^component details?\b/],
  ["detections", /^detections?\b|^detected components?\b|^inventory\b/],
  ["engineering_context", /^engineering context\b/],
  ["observed", /^observed\b/],
  ["corroborated", /^corroborated\b/],
  ["inferred", /^inferred\b/],
  ["conflicting", /^conflicting(\s*\/\s*unknown)?\b/],
  ["unknown", /^unknown\b/],
  ["conflicts", /^conflicts?\b/],
  ["topology", /^topology\b|^connectivity\b|^topology\s*\/\s*connectivity\b/],
  ["revisions", /^revisions?\b|^revision\s*\/\s*changes?\b|^changes?\b/],
  ["impacted", /^impacted\b|^related equipment\b|^impacted assets?\b/],
  ["assets", /^asset hierarchy\b|^assets?\b|^hierarchy\b/],
  ["sources", /^sources?\b|^cited (drawings|sources)\b/],
  ["uncertainty", /^uncertainty\b|^insufficient evidence\b|^unresolved\b/],
  ["pipeline", /^pipeline coverage\b|^analysis coverage\b/],
  ["evidence", /^evidence\b/],
  ["answer", /^answer\b/],
];

/**
 * A line is treated as a heading when it is short, is not a list item, and matches a known
 * pattern. The length bound is what stops an ordinary sentence that happens to begin with
 * "Evidence" from being promoted to a heading.
 */
const MAX_HEADING_LENGTH = 72;

/** Path-like tokens in answer text. Spaces are excluded deliberately — see extractSources. */
const CITED_PATH = /\b[A-Za-z0-9_][A-Za-z0-9_\-./]*\.(png|pdf|graphml)\b/gi;

/** A page reference stated next to a path. */
const PAGE_REFERENCE = /\b(?:p\.?|page)\s*(\d{1,4})\b/i;

/** Engineering tag shapes, used only to emphasise text the answer already contains. */
export const ASSET_TAG = /\b[A-Z]{1,5}-\d{2,5}[A-Z]?\b/g;

/**
 * Split an answer into labelled segments.
 *
 * The concatenation of every returned `raw` equals the input exactly. That invariant is
 * the mechanism by which projection can never hide content: the renderer walks segments
 * instead of the raw string, and walking segments shows everything.
 */
export function splitAnswer(answer: string): AnswerSegment[] {
  if (!answer) {
    return [];
  }

  const lines = answer.split("\n");
  const segments: AnswerSegment[] = [];

  let currentKind: SectionKind | null = null;
  let currentHeading: string | null = null;
  let currentRaw: string[] = [];
  let currentBody: string[] = [];

  const flush = (): void => {
    if (currentRaw.length === 0) {
      return;
    }
    segments.push({
      kind: currentKind ?? "other",
      heading: currentHeading,
      body: currentBody.join("\n").trim(),
      raw: currentRaw.join("\n"),
    });
    currentRaw = [];
    currentBody = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const kind = classifyHeading(line);

    if (kind !== null) {
      flush();
      currentKind = kind;
      currentHeading = line.trim();
      currentRaw = [line];
      currentBody = [];
      continue;
    }

    currentRaw.push(line);
    currentBody.push(line);
  }

  flush();

  // Re-attach the newlines the split consumed, so raw concatenation is exact.
  return segments.map((segment, index) => ({
    ...segment,
    raw: index < segments.length - 1 ? `${segment.raw}\n` : segment.raw,
  }));
}

/**
 * Classify one line as a heading, or return `null`.
 *
 * Exported so a test can assert the exact boundary between "heading" and "ordinary line".
 */
export function classifyHeading(line: string): SectionKind | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) {
    return null;
  }

  // A list item is content, never a heading, even when it starts with a known word.
  if (/^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
    return null;
  }

  const normalised = trimmed
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*(.*?)\*\*:?$/, "$1")
    .replace(/^__(.*?)__:?$/, "$1")
    .replace(/[:：]\s*$/, "")
    .trim()
    .toLowerCase();

  if (!normalised) {
    return null;
  }

  // A heading may carry a parenthetical qualifier: "Observed (from drawings)".
  const withoutQualifier = normalised.replace(/\s*\([^)]*\)\s*$/, "").trim();

  for (const [kind, pattern] of HEADING_PATTERNS) {
    if (pattern.test(withoutQualifier) || pattern.test(normalised)) {
      // Require the heading to be essentially just the keyword, so a sentence beginning
      // with a keyword is not promoted.
      const remainder = withoutQualifier.replace(pattern, "").trim();
      if (remainder.length <= 28) {
        return kind;
      }
    }
  }
  return null;
}

/** Find the first segment of a given kind, or `null`. */
export function findSegment(
  segments: readonly AnswerSegment[],
  kind: SectionKind,
): AnswerSegment | null {
  return segments.find((segment) => segment.kind === kind) ?? null;
}

/**
 * Collect the corpus artifacts behind an answer.
 *
 * Two grounded inputs are combined, and nothing else:
 *
 *  - `toolPaths`, the exact paths the agent passed to a tool, read from persisted tool
 *    arguments. These are facts about what was opened.
 *  - path-like tokens appearing in the answer text.
 *
 * Tokens containing spaces are not matched from text. A path such as
 * `PID2Graph OPEN100/0.graphml` is real, but a regex permissive enough to capture it also
 * captures the words preceding it, which would fabricate a path. Such a path is recovered
 * through `toolPaths` instead, where it is exact.
 *
 * Absolute paths and parent-directory traversals are dropped. If the backend ever emitted
 * one, showing it would leak server topology, and the frontend has no business displaying
 * a location outside the corpus.
 */
export function extractSources(
  answer: string,
  toolPaths: readonly string[] = [],
  knownPaths: readonly string[] = [],
): SourceReference[] {
  const byPath = new Map<string, SourceReference>();
  const opened = new Set<string>();

  for (const path of toolPaths) {
    const reference = buildReference(path, "opened");
    if (reference) {
      byPath.set(reference.path, reference);
      opened.add(reference.path);
    }
  }

  // Paths the backend reported as existing. They are used only to resolve a citation the
  // answer makes; a file existing is not evidence that the answer rests on it, so none of
  // these appears unless the answer actually cites it.
  const verifiable = new Set<string>([...opened, ...knownPaths]);

  for (const line of splitLines(answer)) {
    CITED_PATH.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITED_PATH.exec(line)) !== null) {
      const token = match[0];
      const resolved = resolveCitedPath(line, match.index, token, verifiable);
      if (resolved === null) {
        continue;
      }

      const page = readPageAfter(line, match.index + token.length);
      const existing = byPath.get(resolved);

      if (!existing) {
        const reference = buildReference(resolved, "cited", page);
        if (reference) {
          byPath.set(reference.path, reference);
        }
      } else if (existing.page === undefined && page !== undefined) {
        // Keep the verified provenance and add the page the answer stated.
        byPath.set(resolved, { ...existing, page });
      }
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Split text into lines, tolerating both LF and CRLF endings. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Path-ish characters, used to decide whether a match is a fragment of something longer. */
const PATH_CHARACTER = /[A-Za-z0-9_\-./]/;

/** A whole word made only of path-ish characters, such as a directory name. */
const PATH_WORD = /^[A-Za-z0-9_\-./]+$/;

/**
 * Split an impacted-asset list item into its tag and an optional note.
 *
 * The separator must be a dash or colon *surrounded by whitespace*. Engineering tags
 * contain hyphens — `E-2201`, `P-2101A` — so a bare hyphen cannot be the separator: doing
 * that turns `E-2201 — downstream heat exchanger` into the tag `E` with the note
 * `2201 — downstream heat exchanger`, which is a fabricated identifier.
 */
const TAG_AND_NOTE = /^(.{1,40}?)\s+[—–:-]\s+(.+)$/;

/**
 * Decide what a path-like token found in the answer actually refers to.
 *
 * Corpus paths may contain spaces. When a token is preceded by a space and a path-like
 * word, it is probably the tail of a longer path that the regex could not span. The token
 * is then extended leftwards, word by word, and accepted only if the extension matches a
 * path the agent demonstrably opened.
 *
 * @returns The full path when it can be established, or `null` when the token is a
 *   fragment that cannot be resolved to a real artifact. Returning the fragment would
 *   fabricate a location: it looks like a path, resolves to nothing, and would send an
 *   engineer looking for a file that does not exist.
 */
function resolveCitedPath(
  line: string,
  index: number,
  token: string,
  verifiable: ReadonlySet<string>,
): string | null {
  const before = index > 0 ? line[index - 1] : undefined;

  // Start of line, or preceded by prose or punctuation: the token is the whole path.
  if (before === undefined) {
    return token;
  }

  const precedesPathCharacter = PATH_CHARACTER.test(before);

  if (before === " ") {
    const wordStart = line.lastIndexOf(" ", index - 2) + 1;
    const word = line.slice(wordStart, index - 1);
    // Ordinary prose before the token — "from", "in", an em dash — means it stands alone.
    if (!word || !PATH_WORD.test(word)) {
      return token;
    }
  } else if (!precedesPathCharacter) {
    return token;
  }

  // The token is the tail of something longer: an absolute path, a traversal, or a path
  // whose directory name contains a space. Reporting the tail alone would name a file that
  // does not exist, so the full expression must be recovered and verified.
  const expandedStart = expandLeft(line, index);
  const expanded = line.slice(expandedStart, index + token.length);

  if (verifiable.has(expanded)) {
    return expanded;
  }

  // A leading slash or a traversal is never acceptable, verified or not: it points outside
  // the corpus, and the frontend has no business displaying such a location.
  if (expanded.startsWith("/") || expanded.includes("..")) {
    return null;
  }

  // Try progressively shorter expansions, in case prose preceded the real path.
  let wordStart = expandedStart;
  for (let words = 0; words < 4 && wordStart > 0; words += 1) {
    wordStart = line.lastIndexOf(" ", wordStart - 2) + 1;
    const candidate = line.slice(wordStart, index + token.length);
    if (verifiable.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Walk left from a match over path characters, and over single spaces that separate
 * path-like words.
 *
 * This recovers the full extent of the path expression the token is a tail of, so it can
 * be checked against the set of paths known to exist.
 */
function expandLeft(line: string, index: number): number {
  let start = index;
  while (start > 0) {
    const previous = line[start - 1];
    if (previous === undefined) {
      break;
    }
    if (PATH_CHARACTER.test(previous)) {
      start -= 1;
      continue;
    }
    if (previous === " ") {
      // Cross a space only when the word before it is itself path-like, which is what a
      // corpus directory name containing a space looks like.
      const wordStart = line.lastIndexOf(" ", start - 2) + 1;
      const word = line.slice(wordStart, start - 1);
      if (word && PATH_WORD.test(word)) {
        start = wordStart;
        continue;
      }
    }
    break;
  }
  return start;
}

function buildReference(
  rawPath: string,
  provenance: SourceReference["provenance"],
  page?: number,
): SourceReference | null {
  const path = rawPath.trim();
  if (!path) {
    return null;
  }
  // Never display something outside the corpus, whatever produced it.
  if (path.startsWith("/") || path.includes("..") || /^[A-Za-z]:/.test(path)) {
    return null;
  }

  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension !== "png" && extension !== "pdf" && extension !== "graphml") {
    return null;
  }

  return {
    path,
    kind: extension,
    provenance,
    ...(page === undefined ? {} : { page }),
  };
}

/** Read a page reference stated shortly after a path on the same line. */
function readPageAfter(line: string, fromIndex: number): number | undefined {
  const tail = line.slice(fromIndex, fromIndex + 40);
  const match = PAGE_REFERENCE.exec(tail);
  if (!match?.[1]) {
    return undefined;
  }
  const page = Number(match[1]);
  return Number.isInteger(page) && page > 0 ? page : undefined;
}

/**
 * Determine the answer's own statement about how well it is supported.
 *
 * This reads what the answer says; it never scores it. The order of checks reflects
 * severity: a conflict is the most important thing to report, then an absence of evidence,
 * then partial support, and only then full support. When the answer makes no such
 * statement the result is `not_assessed`, which the card renders honestly rather than
 * defaulting to something reassuring.
 */
export function deriveEvidenceSupport(
  segments: readonly AnswerSegment[],
  answer: string,
): EvidenceSupport {
  const text = answer.toLowerCase();

  const hasConflictSection = segments.some(
    (segment) =>
      (segment.kind === "conflicting" || segment.kind === "conflicts") &&
      segment.body.trim().length > 0,
  );
  if (hasConflictSection || /\bconflicting evidence\b|\bsources disagree\b/.test(text)) {
    return "conflicting";
  }

  if (
    /\binsufficient evidence\b|\bno evidence\b|\bnot supported by the corpus\b|\bcorpus does not\b/.test(
      text,
    )
  ) {
    return "insufficient";
  }

  if (/\bpartial support\b|\bpartially supported\b/.test(text)) {
    return "partial";
  }

  if (/\bhigh support\b|\bwell supported\b|\bcorroborated\b/.test(text)) {
    return "supported";
  }

  const hasObserved = segments.some(
    (segment) => segment.kind === "observed" && segment.body.trim().length > 0,
  );
  const hasInferred = segments.some(
    (segment) => segment.kind === "inferred" && segment.body.trim().length > 0,
  );

  if (hasObserved && !hasInferred) {
    return "supported";
  }
  if (hasObserved && hasInferred) {
    return "partial";
  }

  return "not_assessed";
}

/**
 * Read an explicitly stated connectivity or topology path.
 *
 * Only arrow notation is recognised — `A -> B`, `A → B`, `A ↓ B` — because an arrow is the
 * answer stating a relationship. Adjacency in a list is not a relationship, and treating
 * it as one would manufacture edges.
 */
export function extractTopologySteps(segments: readonly AnswerSegment[]): TopologyStep[] {
  const segment = findSegment(segments, "topology");
  if (!segment) {
    return [];
  }

  for (const line of segment.body.split("\n")) {
    const cleaned = line.replace(/^[-*+]\s*/, "").trim();
    if (!/(->|→|↓|—>)/.test(cleaned)) {
      continue;
    }
    const steps = cleaned
      .split(/\s*(?:->|→|↓|—>)\s*/)
      .map((part) => part.replace(/[.,;]$/, "").trim())
      .filter((part) => part.length > 0 && part.length <= 80);

    if (steps.length >= 2) {
      return steps.map((label) => ({ label }));
    }
  }
  return [];
}

/**
 * Read explicitly listed impacted assets.
 *
 * Only list items inside an impacted-assets section are read. A tag mentioned in prose is
 * not an impact claim, and promoting it to one would be the frontend asserting an
 * engineering finding.
 */
export function extractImpactedAssets(segments: readonly AnswerSegment[]): ImpactedAsset[] {
  const segment = findSegment(segments, "impacted");
  if (!segment) {
    return [];
  }

  const assets: ImpactedAsset[] = [];
  for (const line of segment.body.split("\n")) {
    const item = /^[-*+]\s+(.*)$/.exec(line.trim());
    if (!item?.[1]) {
      continue;
    }
    const content = item[1].trim();
    const parts = TAG_AND_NOTE.exec(content);
    if (parts?.[1] && parts[2]) {
      assets.push({ tag: parts[1].trim(), note: parts[2].trim() });
    } else if (content.length <= 80) {
      assets.push({ tag: content });
    }
  }
  return assets;
}

/**
 * Read an explicitly stated asset hierarchy.
 *
 * Levels come from list indentation or arrow notation, both of which the answer wrote
 * deliberately. Parent-child relationships are never inferred from tag naming.
 */
export function extractAssetHierarchy(
  segments: readonly AnswerSegment[],
): ReadonlyArray<{ readonly label: string; readonly depth: number }> {
  const segment = findSegment(segments, "assets");
  if (!segment) {
    return [];
  }

  const rows: Array<{ label: string; depth: number }> = [];
  for (const line of segment.body.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const indentMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (indentMatch?.[2]) {
      const indent = (indentMatch[1] ?? "").length;
      rows.push({
        label: indentMatch[2].trim(),
        depth: Math.min(Math.floor(indent / 2), 4),
      });
      continue;
    }
    const arrowParts = line.split(/\s*(?:->|→|↓)\s*/).filter((part) => part.trim());
    if (arrowParts.length >= 2) {
      arrowParts.forEach((part, depth) => {
        rows.push({ label: part.trim(), depth: Math.min(depth, 4) });
      });
    }
  }
  return rows;
}

/** Report whether the answer carries any structure worth projecting into cards. */
export function hasProjectableStructure(segments: readonly AnswerSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "other" && segment.kind !== "answer");
}
