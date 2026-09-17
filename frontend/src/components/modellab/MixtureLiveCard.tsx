"use client";

import { useState } from "react";

import { mixtureCounts } from "@/lib/modellab/ingestion";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import local from "./MixtureLiveCard.module.css";
import styles from "./ModelLab.module.css";

const number = (value: number) => value.toLocaleString("en-US");

function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
  return number(value);
}

/**
 * The SFT instruction mixture: planned shares, samples seen per task family so far, and the
 * make-up of the most recent optimiser batch, which changes as the run steps.
 */
export function MixtureLiveCard({ step, now, config }: LiveCardProps) {
  const [active, setActive] = useState<number>();
  const mixture = mixtureCounts(step, config.globalBatch, now);
  const families = mixture.families;

  const arcs = families.map((family, index) => {
    const before = families.slice(0, index).reduce((sum, other) => sum + other.share, 0);
    const sweep = family.share * Math.PI * 2;
    const start = -Math.PI / 2 + before * Math.PI * 2;
    const end = start + sweep;
    const r = active === index ? 66 : 62;
    const inner = 38;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, radius: number) =>
      `${(80 + radius * Math.cos(a)).toFixed(2)},${(80 + radius * Math.sin(a)).toFixed(2)}`;
    return {
      family,
      index,
      d: `M${p(start, r)} A${r},${r} 0 ${large} 1 ${p(end, r)} L${p(end, inner)} A${inner},${inner} 0 ${large} 0 ${p(start, inner)}Z`,
    };
  });
  const focus = active === undefined ? undefined : families[active];

  return (
    <Card
      title="Instruction mixture"
      icon="donut"
      aside={<span className={styles.asideNote}>Sampling: simulated run</span>}
    >
      <div className={styles.mixture}>
        <svg
          viewBox="0 0 160 160"
          role="img"
          aria-label="Instruction mixture by task family"
        >
          {arcs.map(({ family, index, d }) => (
            <path
              key={family.id}
              d={d}
              fill={family.colour}
              opacity={active === undefined || active === index ? 1 : 0.35}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(undefined)}
            />
          ))}
          <text
            x={80}
            y={focus ? 78 : 86}
            textAnchor="middle"
            className={styles.donutValue}
          >
            {focus ? `${Math.round(focus.share * 100)}%` : "100%"}
          </text>
          {focus && (
            <text x={80} y={94} textAnchor="middle" className={styles.donutLabel}>
              {focus.label.split(" ")[0]}
            </text>
          )}
        </svg>
        <ul>
          {families.map((family, index) => (
            <li key={family.id}>
              <button
                type="button"
                aria-pressed={active === index}
                onClick={() =>
                  setActive((current) => (current === index ? undefined : index))
                }
              >
                <i style={{ background: family.colour }} aria-hidden="true" />
                <span>
                  {family.label} ({Math.round(family.share * 100)}%)
                </span>
                <small title={`${number(family.seen)} samples seen`}>
                  {compact(family.seen)} seen
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className={local.batch}>
        <div className={local.batchHead}>
          <strong>Last batch</strong>
          <small>
            Step {number(mixture.batchIndex)} · {number(mixture.batchSize)} samples ·{" "}
            {compact(mixture.totalSeen)} seen in total
          </small>
        </div>
        <div
          className={local.stack}
          role="img"
          aria-label={`Last batch composition: ${families
            .map((family) => `${family.label} ${family.lastBatch}`)
            .join(", ")}`}
        >
          {families.map((family, index) => (
            <i
              key={family.id}
              style={{
                width: `${mixture.batchSize ? (family.lastBatch / mixture.batchSize) * 100 : 0}%`,
                background: family.colour,
              }}
              data-dim={(active !== undefined && active !== index) || undefined}
            />
          ))}
        </div>
        <ul className={local.counts} aria-hidden="true">
          {families.map((family) => {
            const expected = mixture.batchSize * family.share;
            const delta = family.lastBatch - expected;
            return (
              <li key={family.id}>
                <i style={{ background: family.colour }} />
                <b>{family.lastBatch}</b>
                <small>
                  {delta >= 0.5 ? "+" : delta <= -0.5 ? "−" : "±"}
                  {Math.abs(Math.round(delta))}
                </small>
              </li>
            );
          })}
        </ul>
        <p className={local.note}>
          Counts per family in the most recent batch; ± is the difference from the planned
          share.
        </p>
      </div>
    </Card>
  );
}
