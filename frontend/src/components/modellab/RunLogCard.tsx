"use client";

import { useState } from "react";

import {
  nextEvents,
  runEvents,
  type EventFilter,
  type EventSeverity,
} from "@/lib/modellab/events";
import { formatAgo, formatDuration } from "@/lib/modellab/run";

import { Card } from "./Cards";
import { Icon } from "./icons";
import type { LiveCardProps } from "./live";
import local from "./RunLogCard.module.css";

const LIMIT = 8;

const FILTERS: readonly { readonly id: EventFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "warnings", label: "Warnings" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "evals", label: "Evals" },
];

const EMPTY: Record<EventFilter, string> = {
  all: "No events yet.",
  warnings: "No warnings in this run so far.",
  checkpoints: "No checkpoint has been written yet.",
  evals: "No evaluation has finished yet.",
};

const SEVERITY_LABEL: Record<EventSeverity, string> = {
  info: "Info",
  warn: "Warning",
  ok: "OK",
};

function relative(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  return formatAgo(seconds);
}

function SeverityIcon({ severity }: { readonly severity: EventSeverity }) {
  if (severity === "warn") {
    return (
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 4 2.5 20h19zM12 10v4m0 3h.01" />
      </svg>
    );
  }
  return <Icon name={severity === "ok" ? "check" : "info"} size={14} />;
}

export function RunLogCard({ stage, step, now, running, config }: LiveCardProps) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const rate = stage.run.stepsPerSecond;
  const options = { nodes: config.nodes, gpusPerNode: config.gpusPerNode };
  const events = runEvents(stage, step, now, rate, LIMIT, { ...options, filter });
  // Warnings are not scheduled, so that filter keeps the full schedule in view.
  const upcoming = nextEvents(stage, step, now, rate).filter((item) =>
    filter === "checkpoints"
      ? item.kind === "checkpoint"
      : filter === "evals"
        ? item.kind === "eval"
        : true,
  );

  return (
    <Card
      title="Run events"
      icon="bell"
      className={local.card}
      aside={<span className={local.simChip}>Simulated</span>}
    >
      <div className={local.filters} role="group" aria-label="Filter run events">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={local.filter}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {events.length === 0 ? (
        <p className={local.empty}>{EMPTY[filter]}</p>
      ) : (
        <ol className={local.list} aria-label="Latest run events, newest first">
          {events.map((event) => (
            <li key={event.id} className={local.item} data-severity={event.severity}>
              <span className={local.icon} title={SEVERITY_LABEL[event.severity]}>
                <SeverityIcon severity={event.severity} />
              </span>
              <span className={local.text}>
                <span className={local.srOnly}>{SEVERITY_LABEL[event.severity]}: </span>
                {event.message}
                <span className={local.meta}>
                  step {Math.floor(event.step).toLocaleString("en-US")} ·{" "}
                  <time dateTime={new Date(event.atEpoch).toISOString()}>
                    {relative(event.ageSeconds)}
                  </time>
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className={local.upcoming}>
        <strong>Upcoming</strong>
        {upcoming.length === 0 ? (
          <span>Run complete — nothing scheduled</span>
        ) : (
          upcoming.map((item) => (
            <span key={`${item.kind}-${item.step}`}>
              {item.label} in {formatDuration(item.etaSeconds)}
            </span>
          ))
        )}
        {!running && upcoming.length > 0 ? <em>paused</em> : null}
      </p>
    </Card>
  );
}
