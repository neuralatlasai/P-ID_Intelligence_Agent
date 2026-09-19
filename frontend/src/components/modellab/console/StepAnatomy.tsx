"use client";

import { useMemo } from "react";

import { seedOf, white } from "@/lib/modellab/noise";
import type { StageId } from "@/lib/modellab/stages";
import { median, PHASES, type StepFrame } from "@/lib/modellab/telemetry";

import css from "./RunConsole.module.css";

/**
 * Phase colours. A phase is a category, so it takes the categorical series family; waiting
 * (data, advantages) takes a neutral step of the sequential scale so idle time reads as idle.
 */
export const PHASE_COLOUR: Record<string, string> = {
  data: "var(--scale-3)",
  forward: "var(--series-1)",
  backward: "var(--series-3)",
  comm: "var(--series-2)",
  optimizer: "var(--series-4)",
  teacher: "var(--series-6)",
  gen: "var(--series-1)",
  reward: "var(--series-6)",
  old_log_prob: "var(--series-4)",
  ref: "var(--series-8)",
  adv: "var(--scale-3)",
  update_actor: "var(--series-3)",
};

interface Segment {
  readonly phase: string;
  readonly label: string;
  readonly start: number;
  readonly seconds: number;
  /** 1-based micro-batch (or PPO mini-batch) this segment belongs to. */
  readonly part?: number;
  readonly parts?: number;
}

/** PPO mini-batches per reinforcement-learning update. */
const PPO_MINI_BATCHES = 4;

/**
 * Lay a step's phases out in execution order. Under FSDP with gradient accumulation the
 * forward and backward passes alternate per micro-batch — a teacher forward precedes each
 * student forward in distillation — and the exposed tail of the gradient reduce-scatter and
 * the optimizer step close the step. Reinforcement learning follows verl's order, with the
 * actor update split into its PPO mini-batches.
 */
function layout(stageId: StageId, frame: StepFrame, microBatches: number): Segment[] {
  const seconds = (id: string) =>
    frame.phases.find((phase) => phase.id === id)?.seconds ?? 0;
  const label = (id: string) =>
    PHASES[stageId].find((phase) => phase.id === id)?.label ?? id;
  const out: Segment[] = [];
  let cursor = 0;
  const add = (phase: string, duration: number, part?: number, parts?: number) => {
    out.push({ phase, label: label(phase), start: cursor, seconds: duration, part, parts });
    cursor += duration;
  };
  if (stageId === "rl") {
    for (const phase of PHASES.rl) {
      if (phase.id === "update_actor") {
        for (let part = 1; part <= PPO_MINI_BATCHES; part += 1) {
          add(
            "update_actor",
            seconds("update_actor") / PPO_MINI_BATCHES,
            part,
            PPO_MINI_BATCHES,
          );
        }
      } else {
        add(phase.id, seconds(phase.id));
      }
    }
    return out;
  }
  const m = Math.max(1, microBatches);
  add("data", seconds("data"));
  for (let part = 1; part <= m; part += 1) {
    if (stageId === "distillation") add("teacher", seconds("teacher") / m, part, m);
    add("forward", seconds("forward") / m, part, m);
    add("backward", seconds("backward") / m, part, m);
  }
  add("comm", seconds("comm"));
  add("optimizer", seconds("optimizer"));
  return out;
}

function locate(segments: readonly Segment[], at: number): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (at < segment.start + segment.seconds) return index;
  }
  return segments.length - 1;
}

/** Share of a rollout group's completions finished `progress` of the way through generation. */
function completionsDone(progress: number, total: number): number {
  // Decode throughput is flat, but completion lengths are long-tailed: most sequences end
  // early and a few run to the length limit, so the count rises fast and then crawls.
  return Math.min(
    total,
    Math.floor(total * (1 - Math.pow(1 - Math.min(1, progress), 3.2))),
  );
}

const seconds = (value: number) =>
  value >= 100
    ? `${value.toFixed(0)} s`
    : value >= 10
      ? `${value.toFixed(1)} s`
      : `${value.toFixed(2)} s`;

export function StepAnatomy({
  stageId,
  frame,
  fraction,
  recent,
  microBatches,
  completions,
  running,
}: {
  readonly stageId: StageId;
  /** The step currently executing. */
  readonly frame: StepFrame;
  /** Share of it already done, 0..1. */
  readonly fraction: number;
  /** Recently completed steps, oldest first. */
  readonly recent: readonly StepFrame[];
  readonly microBatches: number;
  /** Reinforcement learning: completions generated per step. */
  readonly completions: number;
  readonly running: boolean;
}) {
  const segments = useMemo(
    () => layout(stageId, frame, microBatches),
    [stageId, frame, microBatches],
  );
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const elapsed = Math.min(total, Math.max(0, fraction) * total);
  const current = segments[locate(segments, elapsed)]!;
  const within = current.seconds > 0 ? (elapsed - current.start) / current.seconds : 1;

  const status =
    current.phase === "gen"
      ? `${completionsDone(within, completions).toLocaleString("en-US")} / ${completions.toLocaleString("en-US")} completions`
      : current.part && current.parts
        ? `${stageId === "rl" ? "PPO mini-batch" : "micro-batch"} ${current.part} / ${current.parts}`
        : current.phase === "comm"
          ? "exposed reduce-scatter"
          : current.phase === "optimizer"
            ? "AdamW · sharded"
            : current.phase === "data"
              ? "awaiting batch"
              : "";

  const rows = useMemo(
    () =>
      PHASES[stageId].map((phase) => {
        const now = frame.phases.find((item) => item.id === phase.id)?.seconds ?? 0;
        const typical =
          median(
            recent.map((item) => item.phases.find((p) => p.id === phase.id)?.seconds ?? 0),
          ) ?? now;
        return {
          id: phase.id,
          label: phase.label,
          now,
          typical,
          share: now / Math.max(1e-9, frame.stepSeconds),
          // Worth a reader's attention: materially slower than usual, not merely noisy.
          slow: now > typical * 1.4 && now - typical > 0.5,
        };
      }),
    [stageId, frame, recent],
  );

  const trace = useMemo(
    () => activityTrace(stageId, recent, frame, fraction, microBatches),
    [stageId, recent, frame, fraction, microBatches],
  );

  return (
    <section className={css.anatomy} aria-label="Step anatomy">
      <header className={css.panelHead}>
        <span className={css.panelLabel}>Step anatomy</span>
        <span className={css.panelMeta}>
          step {frame.step.toLocaleString("en-US")} · {running ? "executing" : "held"} ·
          rank 0
        </span>
      </header>

      <div className={css.nowLine} aria-live="off">
        <i style={{ background: PHASE_COLOUR[current.phase] }} aria-hidden="true" />
        <strong>{current.label}</strong>
        {status ? <span>{status}</span> : null}
        <span className={css.nowTime}>
          {seconds(elapsed)} <small>of {seconds(total)}</small>
        </span>
      </div>

      <div
        className={css.timeline}
        role="img"
        aria-label={`Step ${frame.step}: ${current.label}, ${Math.round(fraction * 100)}% through`}
      >
        {segments.map((segment, index) => (
          <span
            key={index}
            className={css.segment}
            data-state={
              segment.start + segment.seconds <= elapsed
                ? "done"
                : segment.start <= elapsed
                  ? "active"
                  : "pending"
            }
            style={{
              flexGrow: Math.max(segment.seconds, total * 0.002),
              background: PHASE_COLOUR[segment.phase],
            }}
          />
        ))}
        <span
          className={css.playhead}
          style={{ left: `${(elapsed / Math.max(1e-9, total)) * 100}%` }}
        />
      </div>

      <table className={css.phaseTable}>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">This step</th>
            <th scope="col">Median · {recent.length}</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-current={row.id === current.phase || undefined}
              data-slow={row.slow || undefined}
            >
              <th scope="row">
                <i style={{ background: PHASE_COLOUR[row.id] }} aria-hidden="true" />
                {row.label}
              </th>
              <td>{seconds(row.now)}</td>
              <td>{seconds(row.typical)}</td>
              <td>{(row.share * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <figure className={css.activity}>
        <figcaption>
          <span>SM activity · rank 0</span>
          <small>{Math.round(trace.window)} s · simulated</small>
        </figcaption>
        <svg
          viewBox="0 0 600 56"
          preserveAspectRatio="none"
          role="img"
          aria-label="Streaming multiprocessor activity over recent steps"
        >
          <path d={trace.area} className={css.activityArea} />
          <path
            d={trace.line}
            className={css.activityLine}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </figure>
    </section>
  );
}

const SM: Record<string, number> = Object.fromEntries(
  Object.values(PHASES)
    .flat()
    .map((phase) => [phase.id, phase.smActivity]),
);

/**
 * SM activity over the last few steps of run time, as a DCGM profile would draw it: high and
 * flat through forward and backward, a notch between micro-batches, a trough in the exposed
 * collectives and while waiting on data. Built from the same step frames as everything else,
 * so a stalled step is visible here as a long trough.
 */
function activityTrace(
  stageId: StageId,
  recent: readonly StepFrame[],
  current: StepFrame,
  fraction: number,
  microBatches: number,
): { area: string; line: string; window: number } {
  const typical = median(recent.map((frame) => frame.stepSeconds)) ?? current.stepSeconds;
  const window = Math.min(900, Math.max(90, typical * 6));
  const currentElapsed = Math.max(0, fraction) * current.stepSeconds;

  // Collect the segments inside the window, walking back from "now" (t = 0).
  type Span = { start: number; end: number; activity: number; notch: number };
  const spans: Span[] = [];
  const place = (segments: readonly Segment[], base: number, limit: number) => {
    for (const segment of segments) {
      const start = base + segment.start;
      const end = Math.min(start + segment.seconds, base + limit);
      if (end <= start) continue;
      // Kernel launch and allocator work between micro-batches shows as a brief dip at the
      // start of each forward pass after the first.
      const notch =
        segment.phase === "forward" && (segment.part ?? 1) > 1
          ? start + segment.seconds * 0.04
          : start;
      spans.push({ start, end, activity: SM[segment.phase] ?? 0.5, notch });
    }
  };
  let offset = -currentElapsed;
  place(layout(stageId, current, microBatches), offset, currentElapsed);
  for (let index = recent.length - 1; index >= 0 && offset > -window; index -= 1) {
    const frame = recent[index]!;
    offset -= frame.stepSeconds;
    place(layout(stageId, frame, microBatches), offset, frame.stepSeconds);
  }
  spans.sort((a, b) => a.start - b.start);

  // Noise is anchored to absolute run time, so as the window slides the texture scrolls with
  // it instead of re-rolling every frame.
  const runNow = (current.step - 1) * typical + currentElapsed;
  const seed = seedOf(`${stageId}:sm`);
  const samples = 240;
  const points: [number, number][] = [];
  let cursor = 0;
  for (let index = 0; index <= samples; index += 1) {
    const t = -window + (window * index) / samples;
    while (cursor < spans.length && spans[cursor]!.end <= t) cursor += 1;
    const span = spans[cursor];
    let activity = 0;
    if (span && t >= span.start && t < span.end) {
      activity = t < span.notch ? span.activity * 0.66 : span.activity;
    }
    const jitter = activity > 0 ? 0.035 * white(seed, Math.floor((runNow + t) * 4)) : 0;
    const x = (index / samples) * 600;
    const y = 54 - Math.max(0, Math.min(1, activity + jitter)) * 50;
    points.push([x, y]);
  }
  const line = points
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join("");
  return { area: `${line}L600 56L0 56Z`, line, window };
}
