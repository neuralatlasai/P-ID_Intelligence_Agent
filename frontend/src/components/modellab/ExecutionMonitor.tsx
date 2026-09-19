"use client";

import { useMemo, useState } from "react";

import {
  buildSyntheticCandidates,
  EXECUTION_RECIPES,
  METHOD_SOURCES,
  type SyntheticCandidate,
} from "@/lib/modellab/execution";
import type { LabSample } from "@/lib/modellab/samples";

import type { LiveCardProps } from "./live";
import css from "./ExecutionMonitor.module.css";

/** Seconds of run time per synthetic batch while following the replay. */
const BATCH_SECONDS = 18;

type Decision = SyntheticCandidate["decision"];

const DECISION: Record<Decision, { readonly label: string; readonly short: string }> = {
  review: { label: "Awaiting review", short: "review" },
  duplicate: { label: "Exact duplicate", short: "dup" },
  "invalid-reference": { label: "Invalid reference", short: "invalid" },
};

type CheckState = "pass" | "fail" | "open";

/**
 * The QC gates a candidate passes through, in order. The first two execute here; the rest
 * are named because admission requires them, and none of them has run.
 */
function checksFor(
  candidate: SyntheticCandidate,
): readonly (readonly [string, CheckState])[] {
  const resolved = candidate.decision !== "invalid-reference";
  const unique = candidate.decision !== "duplicate";
  return [
    ["entity ref", resolved ? "pass" : "fail"],
    ["exact dedup", !resolved ? "open" : unique ? "pass" : "fail"],
    ["split manifest", "open"],
    ["semantic dedup", "open"],
    ["contamination", "open"],
    ["expert review", "open"],
  ];
}

const CHECK_GLYPH: Record<CheckState, string> = { pass: "✓", fail: "✗", open: "○" };

/**
 * Flow of one batch through QC as a Sankey: generated → structural QC → review, duplicate or
 * invalid; review → the admission gates, which admit nothing until they have run. Band width
 * is candidate count.
 */
function QcFlow({
  counts,
  total,
}: {
  readonly counts: Record<Decision, number>;
  readonly total: number;
}) {
  const W = 600;
  const H = 132;
  const unit = (H - 36) / Math.max(1, total);
  const x0 = 70;
  const x1 = 250;
  const x2 = 430;
  const col = 8;
  const top = 18;
  const order: readonly Decision[] = ["review", "duplicate", "invalid-reference"];
  let cursor = top;
  const bands = order.map((decision) => {
    const height = counts[decision] * unit;
    const band = { decision, y: cursor, height };
    cursor += height + (height > 0 ? 6 : 0);
    return band;
  });
  let source = top;
  const ribbon = (y: number, h: number, targetY: number, from: number, to: number) => {
    const mid = (from + to) / 2;
    return `M${from} ${y}C${mid} ${y} ${mid} ${targetY} ${to} ${targetY}V${targetY + h}C${mid} ${targetY + h} ${mid} ${y + h} ${from} ${y + h}Z`;
  };
  const review = bands[0]!;
  return (
    <svg
      className={css.flow}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Synthetic batch QC flow: ${total} generated candidates; ${counts.review} pass structural checks and await review, ${counts.duplicate} rejected as exact duplicates, ${counts["invalid-reference"]} rejected for an invalid entity reference; 0 admitted, because the source split manifest and independent review have not run.`}
    >
      <rect className={css.col} x={x0 - col} y={top} width={col} height={total * unit} />
      <text className={css.flowLabel} x={x0 - col - 6} y={top + 10} textAnchor="end">
        generated
      </text>
      <text className={css.flowCount} x={x0 - col - 6} y={top + 24} textAnchor="end">
        {total}
      </text>
      {bands.map((band) => {
        const y = source;
        source += band.height;
        if (band.height <= 0) return null;
        return (
          <path
            key={band.decision}
            className={css.ribbon}
            data-decision={band.decision}
            d={ribbon(y, band.height, band.y, x0, x1)}
          />
        );
      })}
      {bands.map((band) =>
        band.height > 0 ? (
          <g key={`n-${band.decision}`}>
            <rect
              className={css.col}
              data-decision={band.decision}
              x={x1}
              y={band.y}
              width={col}
              height={band.height}
            />
            <text
              className={css.flowLabel}
              x={x1 + col + 6}
              y={band.y + Math.min(10, band.height / 2 + 4)}
            >
              {DECISION[band.decision].short}{" "}
              <tspan className={css.flowCount}>{counts[band.decision]}</tspan>
            </text>
          </g>
        ) : null,
      )}
      {/* Review → the admission gates: the ribbon runs into a closed gate. */}
      {review.height > 0 && (
        <>
          <path
            className={css.ribbon}
            data-decision="review"
            data-held
            d={ribbon(review.y, review.height, review.y, x1 + col + 70, x2)}
          />
          <line
            className={css.gate}
            x1={x2}
            x2={x2}
            y1={review.y - 6}
            y2={review.y + review.height + 6}
          />
          <text className={css.flowLabel} x={x2 + 8} y={review.y + 10}>
            split · review
          </text>
        </>
      )}
      <rect className={css.col} data-admitted x={W - 70} y={top} width={col} height={2} />
      <text className={css.flowLabel} x={W - 70 + col + 6} y={top + 6}>
        admitted
      </text>
      <text className={css.flowCount} x={W - 70 + col + 6} y={top + 20}>
        0
      </text>
    </svg>
  );
}

/** Shares the run clock; inspection state never mutates the underlying run. */
export function ExecutionMonitor({
  stage,
  step,
  running,
  samples,
  sourceId,
  blocked,
}: LiveCardProps & {
  readonly samples: readonly LabSample[];
  readonly sourceId: string;
  readonly blocked: boolean;
}) {
  const [pinnedBatch, setPinnedBatch] = useState<number | undefined>();
  const [selected, setSelected] = useState(0);
  const recipe = EXECUTION_RECIPES[stage.id];
  // Run seconds elapsed at this step: the replay clock every panel shares.
  const safeStep = blocked || !Number.isFinite(step) ? 0 : Math.max(0, step);
  const tick = Math.floor(safeStep / Math.max(1e-6, stage.run.stepsPerSecond));
  const batch = pinnedBatch ?? Math.floor(tick / BATCH_SECONDS);
  const candidates = useMemo(
    () => buildSyntheticCandidates(samples, sourceId, batch),
    [samples, sourceId, batch],
  );
  const candidate = candidates[selected] ?? candidates[0];
  const counts: Record<Decision, number> = {
    review: 0,
    duplicate: 0,
    "invalid-reference": 0,
  };
  for (const item of candidates) counts[item.decision] += 1;
  const records = Math.ceil(candidates.length / 2);

  return (
    <section
      className={css.root}
      aria-label="Stage execution monitor"
      data-tick={tick}
      data-running={running}
    >
      <header className={css.header}>
        <div>
          <span className={css.fig}>FIGURE 04B · SYNTHETIC DATA QC</span>
          <h3>Synthetic data QC</h3>
        </div>
        <div className={css.state}>
          <code>batch {batch}</code>
          <span className={css.chip} data-pinned={pinnedBatch !== undefined || undefined}>
            {pinnedBatch === undefined ? "following" : "pinned"}
          </span>
          <span className={css.chip} data-tone="hold">
            0 admitted
          </span>
          <span className="srOnly">
            {pinnedBatch === undefined
              ? `Following replay batches · ${BATCH_SECONDS}-second cadence`
              : "Batch pinned for inspection"}
            . {recipe.caveat} Local templates include deliberate duplicate and
            invalid-reference controls; passing them does not establish semantic quality.
          </span>
        </div>
      </header>

      {candidate ? (
        <div className={css.layout} data-batch={batch}>
          <div className={css.left}>
            <QcFlow counts={counts} total={candidates.length} />
            <div className={css.matrixWrap}>
              <div className={css.matrixRows} aria-hidden="true">
                <span>v0</span>
                <span>v1</span>
              </div>
              <div
                className={css.matrix}
                role="group"
                aria-label="Synthetic candidates"
                style={{ gridTemplateColumns: `repeat(${records}, minmax(0, 1fr))` }}
              >
                {candidates.map((item, index) => (
                  <button
                    type="button"
                    key={item.id}
                    className={css.cell}
                    data-decision={item.decision}
                    aria-pressed={candidate.id === item.id}
                    aria-label={`${item.id} ${DECISION[item.decision].label}`}
                    onClick={() => {
                      setPinnedBatch(batch);
                      setSelected(index);
                    }}
                  >
                    <span aria-hidden="true">{DECISION[item.decision].short}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={css.actions}>
              <button
                type="button"
                disabled={pinnedBatch === undefined}
                onClick={() => {
                  setPinnedBatch(undefined);
                  setSelected(0);
                }}
              >
                Follow batches
              </button>
              <button
                type="button"
                disabled={samples.length === 0}
                onClick={() => {
                  setPinnedBatch(batch + 1);
                  setSelected(0);
                }}
              >
                Generate next batch
              </button>
            </div>
          </div>

          <div
            className={css.record}
            role="group"
            aria-label={`Candidate ${candidate.id}: ${DECISION[candidate.decision].label}`}
          >
            <div className={css.recordHead}>
              <code>{candidate.id}</code>
              <span className={css.decision} data-decision={candidate.decision}>
                {DECISION[candidate.decision].label}
              </span>
            </div>
            <dl className={css.fields}>
              <dt>source</dt>
              <dd>
                <code>
                  {candidate.sourceId} · {candidate.nodeId}
                </code>
              </dd>
              <dt>prompt</dt>
              <dd>
                <code>{candidate.prompt}</code>
              </dd>
              <dt>target</dt>
              <dd>
                <code>{candidate.response}</code>
              </dd>
              <dt>generator</dt>
              <dd>
                <code>{candidate.generator}</code>
              </dd>
            </dl>
            <ol className={css.checks} aria-label="QC gates">
              {checksFor(candidate).map(([label, state]) => (
                <li key={label} data-state={state}>
                  <i aria-hidden="true">{CHECK_GLYPH[state]}</i>
                  <span>{label}</span>
                  <span className="srOnly">
                    {state === "pass"
                      ? " passed"
                      : state === "fail"
                        ? " failed"
                        : " not run"}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <p className={css.empty}>
          <span aria-hidden="true">0 source records</span>
          <span className="srOnly">
            No source samples are available. Candidate generation is disabled.
          </span>
        </p>
      )}

      <footer className={css.footer}>
        <details>
          <summary>Method references · verified 18 Sep 2026</summary>
          <div>
            {recipe.sources.map((id) => {
              const source = METHOD_SOURCES[id]!;
              return (
                <a key={id} href={source.url} target="_blank" rel="noreferrer">
                  {source.title} ↗
                </a>
              );
            })}
          </div>
        </details>
      </footer>
    </section>
  );
}
