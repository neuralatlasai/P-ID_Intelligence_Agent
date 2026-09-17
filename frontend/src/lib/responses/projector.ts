/**
 * Projection of native Responses events into transient view state.
 *
 * This is a presentation projection, not a schema. Nothing produced here is ever sent to
 * the backend or treated as engineering truth; the canonical answer is the text the backend
 * persisted, which the transcript reconciles against after the stream ends.
 *
 * Two rules govern what may be projected:
 *
 * Only visible output text reaches the answer surface. Reasoning deltas, reasoning
 * summaries, encrypted reasoning content and refusal internals are recognised so they can
 * be deliberately *not* appended — recognising them is how the exclusion stays true as the
 * protocol grows, rather than depending on a list of things that happen to be absent.
 *
 * Tool activity is reduced to a name and a state. Tool arguments are never surfaced: they
 * can contain corpus paths and query text, and the activity panel exists to show progress,
 * not to expose the agent's working.
 */

import type { ResponseStreamEvent } from "@/lib/responses/native-types";

/** Lifecycle of one streamed run, as the UI understands it. */
export type StreamPhase =
  "idle" | "connecting" | "streaming" | "finalizing" | "completed" | "failed" | "cancelled";

/** Observable state of one tool call. */
export type ActivityState = "requested" | "running" | "complete" | "failed";

/** One row in the activity panel. */
export interface ActivityView {
  /** Stable key, derived from the protocol item id where one exists. */
  readonly id: string;
  /** Tool name as the backend exposes it, or a safe stage label. */
  readonly label: string;
  readonly state: ActivityState;
  readonly startedAt: number;
  readonly completedAt?: number;
}

/** What the projector asks the reducer to do in response to one event. */
export type ProjectedAction =
  | { readonly type: "TEXT_DELTA"; readonly delta: string }
  | { readonly type: "ACTIVITY"; readonly activity: ActivityUpdate }
  | { readonly type: "RESPONSE_STARTED" }
  | { readonly type: "RESPONSE_COMPLETED" }
  | { readonly type: "RESPONSE_FAILED"; readonly message: string }
  | { readonly type: "IGNORED"; readonly eventType: string };

/** An addition to or update of one activity row. */
export interface ActivityUpdate {
  readonly id: string;
  readonly label?: string;
  readonly state: ActivityState;
}

/**
 * Event types whose content is model-internal and must never reach the answer surface.
 *
 * Listed explicitly so the exclusion is a stated decision rather than an accident of which
 * cases the switch happens to handle.
 */
const HIDDEN_REASONING_EVENTS: ReadonlySet<string> = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
]);

/**
 * Tool-call event families, mapped to the activity state they represent.
 *
 * The protocol exposes several tool types with parallel lifecycles. Matching on the suffix
 * keeps one rule for all of them and means a newly added tool family is handled the day it
 * appears rather than the day someone notices it is missing.
 */
const TOOL_STATE_BY_SUFFIX: ReadonlyArray<readonly [string, ActivityState]> = [
  [".in_progress", "running"],
  [".searching", "running"],
  [".interpreting", "running"],
  [".generating", "running"],
  [".completed", "complete"],
  [".failed", "failed"],
];

/**
 * Project one native event into a UI action.
 *
 * An unrecognised event yields `IGNORED` and never throws. A forward-evolving protocol is
 * expected, and an unknown event must not end a conversation the user is in the middle of.
 */
export function projectEvent(event: ResponseStreamEvent): ProjectedAction {
  const type: string = event.type;

  if (HIDDEN_REASONING_EVENTS.has(type)) {
    return { type: "IGNORED", eventType: type };
  }

  switch (type) {
    case "response.created":
    case "response.in_progress":
      return { type: "RESPONSE_STARTED" };

    case "response.output_text.delta": {
      const delta = readString(event, "delta");
      return delta ? { type: "TEXT_DELTA", delta } : { type: "IGNORED", eventType: type };
    }

    case "response.completed":
      return { type: "RESPONSE_COMPLETED" };

    case "response.failed":
    case "response.incomplete":
      return { type: "RESPONSE_FAILED", message: readFailureMessage(event) };

    case "response.error":
      return {
        type: "RESPONSE_FAILED",
        message: readString(event, "message") ?? "Run failed.",
      };

    case "response.output_item.added": {
      const activity = readOutputItemActivity(event, "requested");
      return activity
        ? { type: "ACTIVITY", activity }
        : { type: "IGNORED", eventType: type };
    }

    case "response.output_item.done": {
      const activity = readOutputItemActivity(event, "complete");
      return activity
        ? { type: "ACTIVITY", activity }
        : { type: "IGNORED", eventType: type };
    }

    default:
      break;
  }

  // Tool lifecycle families, matched by suffix.
  for (const [suffix, state] of TOOL_STATE_BY_SUFFIX) {
    if (type.endsWith(suffix) && type.includes("_call")) {
      return {
        type: "ACTIVITY",
        activity: {
          id: readString(event, "item_id") ?? type,
          label: toolFamilyLabel(type),
          state,
        },
      };
    }
  }

  return { type: "IGNORED", eventType: type };
}

/**
 * Build an activity update from an output-item event, when that item is a tool call.
 *
 * Message items are not activities — they are the answer — so they produce no row.
 */
function readOutputItemActivity(
  event: ResponseStreamEvent,
  state: ActivityState,
): ActivityUpdate | null {
  const item = readRecord(event, "item");
  if (!item) {
    return null;
  }

  const itemType = typeof item["type"] === "string" ? item["type"] : "";
  if (!itemType.includes("call")) {
    return null;
  }

  const id =
    (typeof item["id"] === "string" ? item["id"] : undefined) ??
    (typeof item["call_id"] === "string" ? item["call_id"] : undefined) ??
    itemType;

  // The tool's own name where the protocol supplies one; otherwise a readable form of the
  // item type. Arguments are deliberately not read.
  const label =
    typeof item["name"] === "string" && item["name"] ? item["name"] : humanise(itemType);

  return { id, label, state };
}

/** Derive a readable label for a tool lifecycle event family. */
function toolFamilyLabel(eventType: string): string {
  const withoutPrefix = eventType.replace(/^response\./, "");
  const family = withoutPrefix.split(".")[0] ?? withoutPrefix;
  return humanise(family);
}

/** Turn a protocol identifier such as `file_search_call` into `File search call`. */
function humanise(value: string): string {
  const spaced = value.replace(/[._]/g, " ").trim();
  if (!spaced) {
    return "Tool call";
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readString(event: ResponseStreamEvent, key: string): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRecord(
  event: ResponseStreamEvent,
  key: string,
): Record<string, unknown> | undefined {
  const record = event as unknown as Record<string, unknown>;
  const value = record[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extract a failure reason from a terminal event, falling back to a neutral sentence. */
function readFailureMessage(event: ResponseStreamEvent): string {
  const response = readRecord(event, "response");
  const error = response?.["error"];
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }

  const incomplete = response?.["incomplete_details"];
  if (typeof incomplete === "object" && incomplete !== null && "reason" in incomplete) {
    const reason = (incomplete as { reason: unknown }).reason;
    if (typeof reason === "string" && reason) {
      return `The run stopped early: ${humanise(reason).toLowerCase()}.`;
    }
  }

  return "The run did not complete.";
}

/**
 * Apply one activity update to the current list.
 *
 * Rows are keyed and updated in place so a tool that reports `requested` then `running`
 * then `complete` occupies one row that changes state, rather than three rows that look
 * like three separate operations.
 */
export function applyActivity(
  activities: readonly ActivityView[],
  update: ActivityUpdate,
  now: number,
): ActivityView[] {
  const index = activities.findIndex((activity) => activity.id === update.id);

  if (index === -1) {
    return [
      ...activities,
      {
        id: update.id,
        label: update.label ?? "Tool call",
        state: update.state,
        startedAt: now,
        ...(isTerminal(update.state) ? { completedAt: now } : {}),
      },
    ];
  }

  const existing = activities[index];
  if (!existing) {
    return [...activities];
  }

  const next: ActivityView = {
    ...existing,
    label: update.label ?? existing.label,
    state: update.state,
    ...(isTerminal(update.state) ? { completedAt: now } : {}),
  };

  const copy = [...activities];
  copy[index] = next;
  return copy;
}

function isTerminal(state: ActivityState): boolean {
  return state === "complete" || state === "failed";
}
