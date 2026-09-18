"use client";

import type { Incident, IncidentKind } from "@/lib/modellab/incidents";

import { formatStep } from "./SignalChart";
import css from "./RunConsole.module.css";

export const INCIDENT_LABEL: Record<IncidentKind, string> = {
  "loss-spike": "Loss spike",
  "grad-clip-burst": "Clip burst",
  "loader-stall": "Input stall",
  straggler: "Straggler rank",
  "slow-collective": "Slow collective",
  "nonfinite-skip": "Non-finite step",
  "job-restart": "Job restart",
  "rollout-tail": "Rollout tail",
  "kl-excursion": "KL excursion",
  "entropy-drop": "Entropy drop",
  "teacher-queue": "Teacher backlog",
};

/**
 * The whole run on one track: completed span, every incident so far, checkpoint writes and
 * the live position. The most recent incidents are listed as buttons, so inspecting one does
 * not depend on hitting a two-pixel tick.
 */
export function IncidentStrip({
  total,
  step,
  incidents,
  checkpointEvery,
  inspected,
  onInspect,
}: {
  readonly total: number;
  readonly step: number;
  /** Incidents with onset at or before `step`, newest first. */
  readonly incidents: readonly Incident[];
  readonly checkpointEvery: number;
  readonly inspected?: string;
  readonly onInspect: (incident: Incident) => void;
}) {
  const at = (value: number) => `${(Math.min(total, Math.max(0, value)) / total) * 100}%`;
  const checkpoints: number[] = [];
  const every = Math.max(1, checkpointEvery);
  // Too many ticks turn into a grey bar; thin them to at most ~60 across the track.
  const stride = every * Math.max(1, Math.ceil(total / every / 60));
  for (let value = stride; value <= step; value += stride) checkpoints.push(value);
  const counts = new Map<IncidentKind, number>();
  for (const incident of incidents)
    counts.set(incident.kind, (counts.get(incident.kind) ?? 0) + 1);

  return (
    <section className={css.strip} aria-label="Run timeline and incidents">
      <header className={css.panelHead}>
        <span className={css.panelLabel}>Run timeline</span>
        <span className={css.panelMeta}>
          {incidents.length === 0
            ? "no incidents so far"
            : [...counts.entries()]
                .map(([kind, count]) => `${INCIDENT_LABEL[kind]} ${count}`)
                .join(" · ")}
        </span>
      </header>
      <div className={css.track} aria-hidden="true">
        <span className={css.trackDone} style={{ width: at(step) }} />
        {checkpoints.map((value) => (
          <span key={value} className={css.trackCheckpoint} style={{ left: at(value) }} />
        ))}
        {incidents.map((incident) => (
          <span
            key={incident.id}
            className={css.trackIncident}
            data-severity={incident.severity}
            data-inspected={incident.id === inspected || undefined}
            style={{ left: at(incident.step) }}
            title={`${INCIDENT_LABEL[incident.kind]} · step ${incident.step.toLocaleString("en-US")}`}
            onClick={() => onInspect(incident)}
          />
        ))}
        <span className={css.trackHead} style={{ left: at(step) }} />
      </div>
      <div className={css.trackScale} aria-hidden="true">
        <span>0</span>
        <span>{formatStep(total / 2)}</span>
        <span>{formatStep(total)} steps</span>
      </div>
      {incidents.length > 0 ? (
        <ul className={css.recentIncidents} aria-label="Recent incidents">
          {incidents.slice(0, 6).map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                data-severity={incident.severity}
                aria-pressed={incident.id === inspected}
                onClick={() => onInspect(incident)}
              >
                <i aria-hidden="true" />
                <span>{INCIDENT_LABEL[incident.kind]}</span>
                <code>step {incident.step.toLocaleString("en-US")}</code>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
