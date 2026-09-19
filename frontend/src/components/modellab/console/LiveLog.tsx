"use client";

import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { formatRunTime, type LogFilter, type LogLine } from "@/lib/modellab/telemetry";

import css from "./RunConsole.module.css";

const FILTERS: readonly (readonly [LogFilter, string])[] = [
  ["all", "All"],
  ["warnings", "Warnings"],
  ["checkpoints", "Checkpoints"],
  ["evals", "Evaluations"],
];

/**
 * Key/value pairs in any of the three log dialects — `loss: 1.42`, `'loss': 1.42`,
 * `actor/entropy:0.412` — so keys can be set back and values forward. Anything that is not a
 * pair is left as written.
 */
const PAIR =
  /('?[A-Za-z_][\w/@.-]*'?)(:\s*)(-?[\d.]+(?:e[+-]?\d+)?%?|nan|[\d,]+|[\d.]+GiB\([\d.]+%\))/g;

function highlight(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PAIR)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      <Fragment key={index}>
        <span className={css.logKey}>{match[1]}</span>
        {match[2]}
        <span className={css.logValue}>{match[3]}</span>
      </Fragment>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const SOURCE_LABEL: Record<LogLine["source"], string> = {
  trainer: "trainer",
  monitor: "monitor",
  checkpoint: "ckpt",
  eval: "eval",
  nccl: "nccl",
  elastic: "elastic",
};

/**
 * The framework's own log, kept compact. Each line is tied to the run timeline: pointing at
 * a line puts its step under the charts' crosshair and on the timeline track, and a filtered
 * view (history reaching back through the run) marks each line's position in the run.
 */
export function LiveLog({
  lines,
  filter,
  onFilter,
  dialect,
  running,
  total,
  onHoverStep,
}: {
  readonly lines: readonly LogLine[];
  readonly filter: LogFilter;
  readonly onFilter: (filter: LogFilter) => void;
  /** The trainer and its log format, e.g. "torchtitan · FSDP2". */
  readonly dialect: string;
  readonly running: boolean;
  /** The run's total steps: the scale of each line's position mark. */
  readonly total: number;
  readonly onHoverStep: (step: number | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const latest = lines.at(-1)?.id;

  // Stick to the newest line while following. Layout effect, so the jump happens before paint
  // and a new line never flashes in at the wrong scroll position.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow) element.scrollTop = element.scrollHeight;
  }, [latest, follow, filter]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
    if (!atBottom && follow) setFollow(false);
    if (atBottom && !follow) setFollow(true);
  };

  return (
    <section className={css.log} aria-label="Run log">
      <header className={css.panelHead}>
        <span className={css.panelLabel}>Run log</span>
        <span className={css.panelMeta}>{dialect}</span>
        <div className={css.logTools}>
          <div className={css.segmented} role="group" aria-label="Log filter">
            {FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => onFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className={css.followState} data-on={follow && running}>
            <i aria-hidden="true" />
            {follow ? (running ? "Following" : "At latest") : "Scrolled back"}
          </span>
        </div>
      </header>
      <div
        ref={scroller}
        className={css.logBody}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label={`Run log, ${filter === "all" ? "all lines" : filter}`}
      >
        {lines.length === 0 ? (
          <p className={css.logEmpty}>{filter === "warnings" ? "0 warnings" : "empty"}</p>
        ) : (
          <ol
            data-history={filter !== "all" || undefined}
            onMouseLeave={() => onHoverStep(null)}
          >
            {lines.map((line) => (
              <li
                key={line.id}
                data-level={line.level}
                data-source={line.source}
                onMouseEnter={() => onHoverStep(line.step)}
              >
                <span
                  className={css.logRun}
                  aria-hidden="true"
                  title={`step ${line.step.toLocaleString("en-US")}`}
                >
                  <i
                    style={{
                      left: `${(Math.min(total, line.step) / Math.max(1, total)) * 100}%`,
                    }}
                  />
                </span>
                <time>{formatRunTime(line.runSeconds)}</time>
                <b>{line.level}</b>
                <span className={css.logSource}>{SOURCE_LABEL[line.source]}</span>
                <code>{highlight(line.text)}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
      {!follow ? (
        <button
          type="button"
          className={css.jump}
          onClick={() => {
            setFollow(true);
            const element = scroller.current;
            if (element) element.scrollTop = element.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      ) : null}
    </section>
  );
}
