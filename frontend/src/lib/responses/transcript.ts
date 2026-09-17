/**
 * Projection of persisted session items into a renderable transcript.
 *
 * The backend returns its session history as native conversation items. Four shapes matter
 * to the transcript, and they were confirmed against the running backend rather than
 * assumed:
 *
 *   `{ role: "user", content }`                                  a question
 *   `{ type: "function_call", name, arguments, call_id }`        a tool the agent invoked
 *   `{ type: "function_call_output", call_id, output }`          what that tool returned
 *   `{ type: "message", role: "assistant", content: [...] }`     an answer
 *
 * The projector is loss-tolerant by design. An item shape it does not recognise is counted
 * and skipped, never thrown on: history is written by a backend that will grow new item
 * types, and a transcript that refuses to render because of one unfamiliar entry is worse
 * than one that renders everything it understands.
 *
 * Tool *arguments* and tool *output* are read here only to label activity rows and to find
 * cited file paths. Neither is rendered into the answer surface: the answer is what the
 * assistant wrote, not what the tools returned.
 */

import type { ActivityView } from "@/lib/responses/projector";
import { stripWorkspaceContext } from "@/lib/responses/workspace-context";

/** One rendered exchange: the question, the work, and the answer. */
export interface TranscriptTurn {
  readonly id: string;
  /** The user's question as plain text. Rendered as text, never as Markdown or HTML. */
  readonly question: string;
  /** The assistant's answer as Markdown, or an empty string if none was persisted. */
  readonly answer: string;
  /** Observable tool activity, in the order the agent performed it. */
  readonly activities: readonly ActivityView[];
  /** Corpus paths the agent actually opened, taken from tool arguments. */
  readonly toolPaths: readonly string[];
  /**
   * Corpus paths the backend reported as existing, from listing output.
   *
   * Used only to verify a citation in the answer. A file existing is not evidence that
   * the answer rests on it, so these are never displayed on their own.
   */
  readonly knownPaths: readonly string[];
  /** True when the turn has a question but no persisted answer. */
  readonly incomplete: boolean;
}

/** Outcome of projecting a history payload. */
export interface TranscriptProjection {
  readonly turns: readonly TranscriptTurn[];
  /** Items whose shape was not recognised. Surfaced in diagnostics, never as an error. */
  readonly unrecognisedItems: number;
}

/** Keys that carry a corpus-relative path in a tool's arguments. */
const PATH_ARGUMENT_KEYS: readonly string[] = ["path"];

/**
 * Project a history payload into turns.
 *
 * Items are walked in order. A user message opens a turn; tool calls and outputs attach to
 * the open turn; an assistant message closes it. A tool call arriving with no open turn —
 * possible if history were ever truncated at the front — opens one with an empty question
 * rather than being discarded.
 */
export function projectTranscript(items: unknown): TranscriptProjection {
  if (!Array.isArray(items)) {
    return { turns: [], unrecognisedItems: 0 };
  }

  const turns: MutableTurn[] = [];
  let unrecognised = 0;
  let current: MutableTurn | null = null;

  const openTurn = (question: string): MutableTurn => {
    const turn: MutableTurn = {
      id: `turn-${turns.length}`,
      question,
      answer: "",
      activities: [],
      toolPaths: [],
      knownPaths: [],
      answered: false,
    };
    turns.push(turn);
    return turn;
  };

  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) {
      unrecognised += 1;
      continue;
    }
    const item = raw as Record<string, unknown>;

    const role = typeof item["role"] === "string" ? item["role"] : undefined;
    const type = typeof item["type"] === "string" ? item["type"] : undefined;

    // A user message always starts a new turn, even if the previous one never received an
    // answer: an unanswered question is a real state and is shown as one.
    if (role === "user") {
      current = openTurn(stripWorkspaceContext(readText(item["content"])));
      continue;
    }

    if (type === "function_call") {
      current ??= openTurn("");
      const name = typeof item["name"] === "string" ? item["name"] : "Tool call";
      const id =
        (typeof item["call_id"] === "string" ? item["call_id"] : undefined) ??
        (typeof item["id"] === "string" ? item["id"] : undefined) ??
        `${name}-${current.activities.length}`;

      current.activities.push({
        id,
        label: name,
        // History is persisted after the fact, so anything recorded in it ran to
        // completion. An in-flight state would be a guess.
        state: "complete",
        startedAt: 0,
        completedAt: 0,
      });

      const path = readPathArgument(item["arguments"]);
      if (path && !current.toolPaths.includes(path)) {
        current.toolPaths.push(path);
      }
      continue;
    }

    if (type === "function_call_output") {
      // The output is never rendered. It is corpus-derived content, and the assistant's
      // answer is the place where corpus content may appear — already interpreted and
      // attributed.
      //
      // One thing is read from it: the corpus paths a listing reported. Those are real
      // paths the backend enumerated, and knowing them lets a citation in the answer be
      // verified instead of guessed at.
      current ??= openTurn("");
      for (const path of readListedPaths(item["output"])) {
        if (!current.knownPaths.includes(path)) {
          current.knownPaths.push(path);
        }
      }
      continue;
    }

    if (role === "assistant" || type === "message") {
      current ??= openTurn("");
      const text = readText(item["content"]);
      if (text) {
        current.answer = current.answer ? `${current.answer}\n\n${text}` : text;
        current.answered = true;
      }
      continue;
    }

    unrecognised += 1;
  }

  return {
    turns: turns.map((turn) => ({
      id: turn.id,
      question: turn.question,
      answer: turn.answer,
      activities: turn.activities,
      toolPaths: turn.toolPaths,
      knownPaths: turn.knownPaths,
      incomplete: !turn.answered,
    })),
    unrecognisedItems: unrecognised,
  };
}

interface MutableTurn {
  id: string;
  question: string;
  answer: string;
  activities: ActivityView[];
  toolPaths: string[];
  knownPaths: string[];
  answered: boolean;
}

/**
 * Read visible text from an item's `content`.
 *
 * Content is a bare string for a simple message and an array of typed parts for a model
 * response. Only parts that carry visible text are read; anything else — refusal details,
 * reasoning, images, files — is skipped, which is what keeps model-internal content out of
 * the transcript by construction rather than by later filtering.
 */
export function readText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const part = entry as Record<string, unknown>;
    const partType = typeof part["type"] === "string" ? part["type"] : "";
    if (partType === "output_text" || partType === "input_text" || partType === "text") {
      const text = part["text"];
      if (typeof text === "string" && text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

/**
 * Corpus inventory lines, as the listing tool formats them.
 *
 * `area_100/PID-100.png | png | 93211 bytes | mtime=2026-09-15T13:23:43+00:00`
 *
 * The leading field is the corpus-relative path, and it may contain spaces. Anchoring on
 * the ` | <kind> | ` shape that follows it is what makes the path recoverable exactly,
 * without a regex that would otherwise have to guess where the path ends.
 */
const INVENTORY_LINE = /^(.+?)\s\|\s(png|pdf|graphml)\s\|\s\d+\sbytes\b/;

/**
 * Read the corpus paths a listing reported.
 *
 * These are paths the backend enumerated, so they are facts about what exists. They are
 * used only to verify citations that appear in the answer; they are never displayed on
 * their own, because a file existing is not evidence that the answer rests on it.
 */
export function readListedPaths(output: unknown): string[] {
  if (typeof output !== "string" || !output.includes("|")) {
    return [];
  }

  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const match = INVENTORY_LINE.exec(line.trim());
    const path = match?.[1]?.trim();
    if (path && !path.startsWith("/") && !path.includes("..")) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Read a corpus path from a tool call's JSON arguments.
 *
 * Arguments are a JSON string. Malformed arguments yield no path rather than an error —
 * the path is used to enrich a citation list, and failing to enrich it is not a reason to
 * fail the transcript.
 */
export function readPathArgument(rawArguments: unknown): string | null {
  if (typeof rawArguments !== "string" || !rawArguments) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
