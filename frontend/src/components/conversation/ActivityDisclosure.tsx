"use client";

import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { CheckIcon, AlertIcon, StopIcon } from "@/components/ui/icons";
import { StatusDot } from "@/components/ui/StatusDot";
import type { ActivityView, StreamPhase } from "@/lib/responses/projector";

import styles from "./ActivityDisclosure.module.css";

export interface ActivityDisclosureProps {
  readonly activities: readonly ActivityView[];
  readonly phase: StreamPhase;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly onCancel?: () => void;
}

/**
 * Observable progress for one run.
 *
 * What appears here is bounded on purpose: the tool's name and its state, and nothing else.
 * No hidden reasoning, no reasoning summary, and no tool arguments — arguments carry corpus
 * paths and query text, and this panel exists to show that work is happening, not to expose
 * the agent's working.
 *
 * It opens itself while a run is active and collapses once the answer is complete, so a
 * finished transcript is not a wall of expanded step lists.
 */
export function ActivityDisclosure({
  activities,
  phase,
  open,
  onToggle,
  onCancel,
}: ActivityDisclosureProps) {
  const active = phase === "connecting" || phase === "streaming" || phase === "finalizing";

  if (activities.length === 0 && !active) {
    return null;
  }

  const title = active ? "Working..." : "Activity & tool calls";

  return (
    <Disclosure
      title={title}
      count={activities.length > 0 ? `${activities.length} steps` : undefined}
      open={open}
      onToggle={onToggle}
      leading={
        active ? <StatusDot tone="checking" label="" pulsing hideLabel /> : undefined
      }
      trailing={
        active && onCancel ? (
          <span className={styles.stopWrap}>
            <Button size="sm" leadingIcon={<StopIcon size={13} />} onClick={onCancel}>
              Stop
            </Button>
          </span>
        ) : undefined
      }
    >
      {/*
        Status is announced politely. The answer text itself is not a live region:
        announcing every token would make the page unusable with a screen reader.
      */}
      <div className={styles.list} aria-live="polite" aria-atomic="false">
        {activities.length > 0 ? (
          <p className={styles.pipelineNote}>
            Evidence pipeline: discover sources, inspect drawings or documents, query
            topology, then verify the answer.
          </p>
        ) : null}
        {phase === "connecting" && activities.length === 0 ? (
          <p className={styles.connecting}>Connecting to the analysis service...</p>
        ) : null}

        {activities.map((activity) => (
          <p key={activity.id} className={styles.row}>
            <span className={[styles.rowIcon, toneClass(activity)].join(" ")}>
              {activity.state === "complete" ? (
                <CheckIcon size={13} />
              ) : activity.state === "failed" ? (
                <AlertIcon size={13} />
              ) : (
                <span aria-hidden="true">&bull;</span>
              )}
            </span>
            <span className={styles.activityText}>
              <span className={styles.purpose}>{describeTool(activity.label)}</span>
              <span className={styles.name}>{activity.label}</span>
            </span>
            <span className="metaText">{describeState(activity)}</span>
          </p>
        ))}

        {phase === "finalizing" ? (
          <p className={styles.connecting}>Finalizing session...</p>
        ) : null}
      </div>
    </Disclosure>
  );
}

/** Translate implementation names without hiding the exact operation that ran. */
function describeTool(label: string): string {
  const descriptions: Readonly<Record<string, string>> = {
    list_corpus_files: "Find relevant source files",
    load_corpus_artifact: "Open a source artifact",
    render_drawing_region: "Inspect a drawing detail",
    render_pdf_page: "Inspect a document page",
    search_pdf_text: "Search document text",
    graph_summary: "Read the drawing structure",
    graph_find_nodes: "Resolve a component identity",
    graph_neighbors: "Trace nearby connections",
    graph_shortest_path: "Trace a path between components",
    graph_edge_lookup: "Inspect connection details",
  };
  return descriptions[label] ?? "Run an evidence operation";
}

function toneClass(activity: ActivityView): string {
  if (activity.state === "complete") {
    return styles.complete ?? "";
  }
  if (activity.state === "failed") {
    return styles.failed ?? "";
  }
  return styles.pending ?? "";
}

/**
 * Describe a step's state in words.
 *
 * Text, not colour: the icon and the colour reinforce it, but a greyscale display or a
 * screen reader still conveys the state.
 */
function describeState(activity: ActivityView): string {
  switch (activity.state) {
    case "complete":
      return "done";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return "requested";
  }
}
