"use client";

import { useMemo, useState } from "react";

import { mixtureCounts, type MixtureCounts } from "@/lib/modellab/ingestion";
import { seriesColour } from "@/lib/series";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import local from "./MixtureLiveCard.module.css";

const number = (value: number) => value.toLocaleString("en-US");

function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
  return number(value);
}

/** Batches drawn in the stream, oldest on the left. */
const HISTORY = 32;
const W = 470;
const H = 196;
const STREAM_W = 244;
const TOP = 14;
const BAND_H = H - TOP - 20;
const LABEL_X = STREAM_W + 22;

/**
 * The instruction mixture as a stacked stream: every column is one optimiser batch, split by
 * task family, the last {HISTORY} batches of the simulated run. Dashed rules are the planned
 * shares, so the multinomial scatter of each batch reads against the plan; the newest column
 * is the step the run console reports, and the stream advances with it.
 */
export function MixtureLiveCard({ step, now, config }: LiveCardProps) {
  const [active, setActive] = useState<number>();
  const current = mixtureCounts(step, config.globalBatch, now);
  const batchIndex = current.batchIndex;
  const history = useMemo(() => {
    const out: MixtureCounts[] = [];
    for (let s = batchIndex - HISTORY + 1; s <= batchIndex; s += 1) {
      if (s < 1) continue;
      out.push(mixtureCounts(s, config.globalBatch, 0));
    }
    return out;
  }, [batchIndex, config.globalBatch]);
  const families = current.families;
  const colW = STREAM_W / HISTORY;
  const offset = HISTORY - history.length;

  // Planned cumulative boundaries, and each family's band centre in the newest batch.
  const planned: number[] = [];
  let acc = 0;
  for (const family of families) {
    acc += family.share;
    planned.push(acc);
  }
  const latestCentres: number[] = [];
  let run = 0;
  for (const family of families) {
    const share = current.batchSize ? family.lastBatch / current.batchSize : family.share;
    latestCentres.push(TOP + (run + share / 2) * BAND_H);
    run += share;
  }
  // Labels keep 30 units apart; the band centres their leaders point at stay exact.
  const labelY = latestCentres.map((y) => Math.max(y, 30));
  for (let i = 1; i < labelY.length; i += 1)
    labelY[i] = Math.max(labelY[i]!, labelY[i - 1]! + 30);
  const overflow = (labelY.at(-1) ?? 0) - (H - 12);
  if (overflow > 0) for (let i = 0; i < labelY.length; i += 1) labelY[i]! -= overflow;

  const label = `Instruction mixture, last ${history.length} batches of ${number(current.batchSize)} to step ${number(batchIndex)}, simulated sampling. ${families
    .map((family) => {
      const delta = family.lastBatch - current.batchSize * family.share;
      return `${family.label}: plan ${Math.round(family.share * 100)}%, ${family.lastBatch} in the last batch (${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta))}), ${number(family.seen)} seen`;
    })
    .join("; ")}. ${number(current.totalSeen)} samples seen in total.`;

  return (
    <Card
      title="Instruction mixture"
      icon="donut"
      aside={
        <span className={local.chips}>
          <span className={local.chip} data-kind="sim">
            sim
          </span>
          <span className={local.chip}>
            B {number(current.batchSize)} · Σ {compact(current.totalSeen)}
          </span>
        </span>
      }
    >
      <div className={local.body}>
        <svg
          className={local.stream}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          onPointerLeave={() => setActive(undefined)}
        >
          {history.map((batch, column) => {
            let y = TOP;
            const x = (column + offset) * colW;
            const newest = column === history.length - 1;
            return (
              <g key={batch.batchIndex} data-newest={newest || undefined}>
                {batch.families.map((family, index) => {
                  const h = batch.batchSize
                    ? (family.lastBatch / batch.batchSize) * BAND_H
                    : 0;
                  const rect = (
                    <rect
                      key={family.id}
                      className={local.cell}
                      data-dim={(active !== undefined && active !== index) || undefined}
                      x={x}
                      y={y}
                      width={Math.max(0.5, colW - 1)}
                      height={h}
                      style={{ fill: seriesColour(index) }}
                    />
                  );
                  y += h;
                  return rect;
                })}
              </g>
            );
          })}
          {/* Newest batch: outlined, it is the one the run console is on. */}
          {history.length > 0 && (
            <rect
              className={local.newest}
              x={(HISTORY - 1) * colW - 0.5}
              y={TOP - 0.5}
              width={colW}
              height={BAND_H + 1}
            />
          )}
          {planned.slice(0, -1).map((share, index) => (
            <line
              key={index}
              className={local.plan}
              x1={0}
              x2={STREAM_W}
              y1={TOP + share * BAND_H}
              y2={TOP + share * BAND_H}
            />
          ))}
          <text className={local.axis} x={0} y={H - 4}>
            {number(Math.max(1, batchIndex - HISTORY + 1))}
          </text>
          <text className={local.axis} x={STREAM_W} y={H - 4} textAnchor="end">
            step {number(batchIndex)}
          </text>

          <text className={local.axis} x={LABEL_X + 14} y={8} aria-hidden="true">
            n Δplan · plan · seen
          </text>
          {families.map((family, index) => {
            const expected = current.batchSize * family.share;
            const delta = family.lastBatch - expected;
            const y = labelY[index]!;
            return (
              <g
                key={family.id}
                className={local.label}
                data-dim={(active !== undefined && active !== index) || undefined}
                onPointerEnter={() => setActive(index)}
              >
                <path
                  className={local.leader}
                  d={`M${STREAM_W + 2} ${latestCentres[index]!.toFixed(1)}L${LABEL_X - 6} ${(y - 4).toFixed(1)}`}
                />
                <rect
                  x={LABEL_X}
                  y={y - 11}
                  width={8}
                  height={8}
                  style={{ fill: seriesColour(index) }}
                />
                <text className={local.family} x={LABEL_X + 14} y={y - 3}>
                  {family.label}
                </text>
                <text className={local.numbers} x={LABEL_X + 14} y={y + 11}>
                  <tspan className={local.strong}>{family.lastBatch}</tspan>
                  <tspan>
                    {" "}
                    {delta >= 0.5 ? "+" : delta <= -0.5 ? "−" : "±"}
                    {Math.abs(Math.round(delta))}
                  </tspan>
                  <tspan>
                    {" "}
                    · {Math.round(family.share * 100)}% · {compact(family.seen)}
                  </tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </Card>
  );
}
