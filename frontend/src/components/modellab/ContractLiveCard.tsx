"use client";

import { useMemo, useState, type CSSProperties } from "react";

import {
  batchRewards,
  epochPosition,
  ingestionFor,
  type IngestionRow,
} from "@/lib/modellab/ingestion";
import type { CorpusFacts } from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";
import { seriesColour } from "@/lib/series";

import { Card } from "./Cards";
import local from "./ContractLiveCard.module.css";
import type { LiveCardProps } from "./live";
import { MODALITY_COLOUR } from "./visual/conversion";
import {
  KEY_MEANING,
  edgeWidth,
  joinGraph,
  type JoinGraph,
  type JoinSource,
} from "./visual/joinGraph";

const number = (value: number) => value.toLocaleString("en-US");

function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e4) return `${Math.round(value / 1e3)}K`;
  return number(value);
}

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

type PipeState = "synced" | "indexing" | "awaiting" | "off";

const STATE: Record<IngestionRow["status"], PipeState> = {
  Synced: "synced",
  Indexing: "indexing",
  "Awaiting source": "awaiting",
  "Not connected": "off",
};

/**
 * §01 as figures. Dataset stages: a join graph — contract sources, the keys they are joined
 * on and the model inputs those joins feed — with edge width from real counts (log scale),
 * pipeline state as marks, and each source's coverage and current-epoch consumption as bars
 * that move with the run. Reinforcement learning: the reward contract as diverging weight
 * bars, filled by the simulated batch's contribution, and their sum.
 */
export function ContractLiveCard({
  stage,
  step,
  progress,
  now,
  config,
  facts,
}: LiveCardProps & { readonly facts: CorpusFacts }) {
  if (stage.rewards) {
    return <RewardContract stage={stage} step={step} progress={progress} />;
  }
  const ingestion = ingestionFor(stage, facts, step, config.globalBatch, now);
  const epoch = epochPosition(stage, step, config.globalBatch);
  return (
    <Card
      title={stage.contractTitle}
      icon="contract"
      id="data-contract"
      aside={
        <span className={local.chips}>
          <span className={local.chip} data-kind="sim">
            {facts.source === "demo" ? "fixture" : "sim sync"}
          </span>
          <span className={local.chip}>
            ep {epoch.epoch} · {Math.floor(epoch.share * 100)}%
          </span>
        </span>
      }
    >
      <JoinFigure stage={stage} facts={facts} ingestion={ingestion} />
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Join graph
// ────────────────────────────────────────────────────────────────────────────────────────────

const W = 1120;
const SRC_X = 0;
const SRC_W = 340;
const SRC_H = 60;
const SRC_GAP = 10;
const JOIN_X = 480;
const JOIN_W = 196;
const NODE_H = 40;
const INPUT_X = 900;
const INPUT_W = 220;
const PAD_Y = 22;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function stackBoxes(count: number, x: number, w: number, h: number, band: number): Box[] {
  const gap = count > 1 ? Math.min(28, (band - count * h) / (count - 1)) : 0;
  const used = count * h + Math.max(0, count - 1) * gap;
  const top = PAD_Y + (band - used) / 2;
  return Array.from({ length: count }, (_, i) => ({ x, y: top + i * (h + gap), w, h }));
}

/** Spread k anchors down a box edge, so parallel edges do not overprint. */
function anchor(box: Box, index: number, count: number): number {
  const spread = Math.min(9, (box.h - 14) / Math.max(1, count));
  return box.y + box.h / 2 + (index - (count - 1) / 2) * spread;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1.toFixed(1)}C${mx} ${y1.toFixed(1)} ${mx} ${y2.toFixed(1)} ${x2} ${y2.toFixed(1)}`;
}

interface EdgePath {
  readonly key: string;
  readonly d: string;
  readonly width: number;
  readonly from: string;
  readonly to: string;
  readonly stage: "join" | "input";
  readonly count: number;
}

type Edge = JoinGraph["edges"][number];

/** Fixed-coordinate layout: three stacked columns, edges anchored in far-end order. */
function layoutGraph(graph: JoinGraph) {
  const band = Math.max(
    graph.sources.length * (SRC_H + SRC_GAP) - SRC_GAP,
    graph.joins.length * (NODE_H + 12),
    graph.inputs.length * (NODE_H + 12),
  );
  const height = band + PAD_Y * 2;
  const place = (ids: readonly string[], x: number, w: number, h: number) =>
    new Map(stackBoxes(ids.length, x, w, h, band).map((box, i) => [ids[i]!, box]));
  const srcBoxes = place(
    graph.sources.map((s) => s.id),
    SRC_X,
    SRC_W,
    SRC_H,
  );
  const joinBoxes = place(
    graph.joins.map((j) => j.id),
    JOIN_X,
    JOIN_W,
    NODE_H,
  );
  const inputBoxes = place(
    graph.inputs.map((i) => i.id),
    INPUT_X,
    INPUT_W,
    NODE_H,
  );
  const leftBox = (edge: Edge) =>
    edge.stage === "join" ? srcBoxes.get(edge.from) : joinBoxes.get(edge.from);
  const rightBox = (edge: Edge) =>
    edge.stage === "join" ? joinBoxes.get(edge.to) : inputBoxes.get(edge.to);
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const l = `${edge.stage}:${edge.from}`;
    const r = `${edge.stage}:${edge.to}`;
    outgoing.set(l, [...(outgoing.get(l) ?? []), edge]);
    incoming.set(r, [...(incoming.get(r) ?? []), edge]);
  }
  for (const list of outgoing.values())
    list.sort((a, b) => (rightBox(a)?.y ?? 0) - (rightBox(b)?.y ?? 0));
  for (const list of incoming.values())
    list.sort((a, b) => (leftBox(a)?.y ?? 0) - (leftBox(b)?.y ?? 0));
  const edgePaths: EdgePath[] = [];
  for (const edge of graph.edges) {
    const a = leftBox(edge);
    const b = rightBox(edge);
    if (!a || !b) continue;
    const outs = outgoing.get(`${edge.stage}:${edge.from}`)!;
    const ins = incoming.get(`${edge.stage}:${edge.to}`)!;
    const y1 = anchor(a, outs.indexOf(edge), outs.length);
    const y2 = anchor(b, ins.indexOf(edge), ins.length);
    edgePaths.push({
      key: `${edge.stage}:${edge.from}>${edge.to}`,
      d: curve(a.x + a.w, y1, b.x, y2),
      width: edgeWidth(edge.count, graph.max),
      from: edge.from,
      to: edge.to,
      stage: edge.stage,
      count: edge.count,
    });
  }
  return { height, srcBoxes, joinBoxes, inputBoxes, edgePaths };
}

function JoinFigure({
  stage,
  facts,
  ingestion,
}: {
  readonly stage: Stage;
  readonly facts: CorpusFacts;
  readonly ingestion: ReadonlyMap<string, IngestionRow>;
}) {
  const graph = useMemo(() => joinGraph(stage, facts), [stage, facts]);
  const [hover, setHover] = useState<string>();

  const { height, srcBoxes, joinBoxes, inputBoxes, edgePaths } = useMemo(
    () => layoutGraph(graph),
    [graph],
  );

  // A hovered node lights its own edges and everything one hop along them.
  const lit = useMemo(() => {
    if (!hover) return undefined;
    const set = new Set<string>([hover]);
    for (const edge of graph.edges) {
      if (edge.from === hover || edge.to === hover) {
        set.add(edge.from);
        set.add(edge.to);
      }
    }
    return set;
  }, [hover, graph]);
  const dim = (id: string) => (lit && !lit.has(id) ? true : undefined);

  const label = describeGraph(stage, graph, ingestion);

  return (
    <div
      className={local.scroll}
      tabIndex={0}
      role="region"
      aria-label={`${stage.contractTitle} join graph`}
    >
      <svg
        className={local.graph}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={label}
        onPointerLeave={() => setHover(undefined)}
      >
        <g className={local.columnHeads} aria-hidden="true">
          <text x={SRC_X} y={12}>
            SOURCE · n / plan
          </text>
          <text x={JOIN_X} y={12}>
            JOIN KEY
          </text>
          <text x={INPUT_X} y={12}>
            MODEL INPUT
          </text>
        </g>

        {edgePaths.map((edge) => {
          const faint = lit ? !(lit.has(edge.from) && lit.has(edge.to)) : false;
          return (
            <path
              key={edge.key}
              className={local.edge}
              data-empty={edge.count <= 0 || undefined}
              data-dim={faint || undefined}
              d={edge.d}
              style={
                {
                  strokeWidth: edge.count > 0 ? edge.width : 1,
                  "--edge":
                    edge.stage === "input"
                      ? MODALITY_COLOUR[edge.to as keyof typeof MODALITY_COLOUR]
                      : "var(--ink-secondary)",
                } as CSSProperties
              }
            >
              <title>
                {`${edge.from} → ${edge.to}: ${edge.count > 0 ? number(edge.count) : "no join"}`}
              </title>
            </path>
          );
        })}

        {graph.sources.map((source) => (
          <SourceNode
            key={source.id}
            source={source}
            box={srcBoxes.get(source.id)!}
            pipe={ingestion.get(source.id)}
            dim={dim(source.id)}
            onHover={() => setHover(source.id)}
          />
        ))}

        {graph.joins.map((join) => {
          const box = joinBoxes.get(join.id)!;
          return (
            <g
              key={join.id}
              className={local.node}
              data-empty={join.count <= 0 || undefined}
              data-dim={dim(join.id)}
              onPointerEnter={() => setHover(join.id)}
            >
              <title>{`${join.id} · ${KEY_MEANING[join.id]} · ${number(join.count)}`}</title>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
              <text className={local.key} x={box.x + 10} y={box.y + box.h / 2 + 4}>
                {join.id}
              </text>
              <text
                className={local.count}
                x={box.x + box.w - 10}
                y={box.y + box.h / 2 + 4}
                textAnchor="end"
              >
                {join.count > 0 ? compact(join.count) : "0"}
              </text>
            </g>
          );
        })}

        {graph.inputs.map((input) => {
          const box = inputBoxes.get(input.id)!;
          return (
            <g
              key={input.id}
              className={local.node}
              data-dim={dim(input.id)}
              onPointerEnter={() => setHover(input.id)}
            >
              <title>{`${input.id} · ${number(input.count)}`}</title>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
              <rect
                x={box.x}
                y={box.y}
                width={3}
                height={box.h}
                style={{ fill: MODALITY_COLOUR[input.id] }}
              />
              <text className={local.inputName} x={box.x + 14} y={box.y + box.h / 2 + 4}>
                {input.id}
              </text>
              <text
                className={local.count}
                x={box.x + box.w - 10}
                y={box.y + box.h / 2 + 4}
                textAnchor="end"
              >
                {compact(input.count)}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className={local.legend} aria-hidden="true">
        <li>
          <svg viewBox="0 0 26 10">
            <path d="M0 3H26" className={local.swatch} style={{ strokeWidth: 1.5 }} />
            <path d="M0 8H26" className={local.swatch} style={{ strokeWidth: 4 }} />
          </svg>
          width = log n
        </li>
        <li>
          <svg viewBox="0 0 26 10">
            <path d="M0 5H26" className={local.swatch} data-empty />
          </svg>
          no join
        </li>
        {(["synced", "indexing", "awaiting", "off"] as const).map((state) => (
          <li key={state}>
            <i className={local.dot} data-state={state} />
            {state}
          </li>
        ))}
        <li>
          <i className={local.bar} data-kind="coverage" />n / plan
        </li>
        <li>
          <i className={local.bar} data-kind="epoch" />
          epoch
        </li>
      </ul>
    </div>
  );
}

function SourceNode({
  source,
  box,
  pipe,
  dim,
  onHover,
}: {
  readonly source: JoinSource;
  readonly box: Box;
  readonly pipe: IngestionRow | undefined;
  readonly dim: true | undefined;
  readonly onHover: () => void;
}) {
  const state: PipeState = pipe ? STATE[pipe.status] : "off";
  const coverage = source.target > 0 ? Math.min(1, source.count / source.target) : 0;
  const consumed = pipe && pipe.available > 0 ? pipe.consumed / pipe.available : 0;
  const inner = box.w - 20;
  const coverageW = source.count > 0 ? Math.max(2, coverage * inner) : 0;
  return (
    <g
      className={local.source}
      data-state={state}
      data-stale={pipe?.freshness === "stale" || undefined}
      data-dim={dim}
      onPointerEnter={onHover}
    >
      <title>
        {[
          source.name,
          source.format,
          source.volume,
          source.notes,
          source.basis,
          pipe ? `${pipe.status} · ${pipe.syncLabel}` : "",
          pipe && pipe.available > 0
            ? `${number(pipe.consumed)} / ${number(pipe.available)} consumed, epoch ${pipe.epoch}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </title>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
      <circle className={local.mark} cx={box.x + 13} cy={box.y + 16} r={3.5} />
      <text className={local.name} x={box.x + 24} y={box.y + 20}>
        {source.name}
      </text>
      <text className={local.format} x={box.x + box.w - 10} y={box.y + 20} textAnchor="end">
        {source.format}
      </text>
      <text className={local.count} x={box.x + 10} y={box.y + 38}>
        <tspan className={local.strong}>{number(source.count)}</tspan>
        <tspan> / {source.targetLabel}</tspan>
      </text>
      <text className={local.format} x={box.x + box.w - 10} y={box.y + 38} textAnchor="end">
        {pipe?.freshness === "static"
          ? state === "off"
            ? "off"
            : "fixture"
          : age(pipe?.secondsSinceSync ?? null)}
      </text>
      <rect
        className={local.track}
        x={box.x + 10}
        y={box.y + 44}
        width={inner}
        height={3}
      />
      <rect
        className={local.coverage}
        x={box.x + 10}
        y={box.y + 44}
        width={coverageW}
        height={3}
      />
      <rect
        className={local.track}
        x={box.x + 10}
        y={box.y + 50}
        width={inner}
        height={2}
      />
      <rect
        className={local.epoch}
        x={box.x + 10}
        y={box.y + 50}
        width={consumed * inner}
        height={2}
      />
    </g>
  );
}

function describeGraph(
  stage: Stage,
  graph: JoinGraph,
  ingestion: ReadonlyMap<string, IngestionRow>,
): string {
  const sources = graph.sources
    .map((source) => {
      const pipe = ingestion.get(source.id);
      const consumed =
        pipe && pipe.available > 0
          ? `, ${number(pipe.consumed)} consumed in epoch ${pipe.epoch}`
          : "";
      return `${source.name} ${number(source.count)} of ${source.targetLabel} (${source.basis}; ${pipe?.status ?? "Not connected"}${consumed})`;
    })
    .join("; ");
  const joins = graph.joins
    .map((join) => `${join.id} ${join.count > 0 ? number(join.count) : "no join"}`)
    .join(", ");
  const inputs = graph.inputs
    .map((input) => `${input.id} ${number(input.count)}`)
    .join(", ");
  return `${stage.contractTitle} join graph. Sources, available now of planned: ${sources}. Joined on: ${joins}. Model inputs: ${inputs}. Edge width is the log of the count; counts are real corpus counts, sync and consumption follow the simulated run.`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Reward contract (stage 3)
// ────────────────────────────────────────────────────────────────────────────────────────────

const R_W = 1120;
const ROW_H = 38;
const ZERO_X = 700;
/** Pixels per unit of weight: ±0.2 reaches 220 px either side of zero. */
const PER = 1100;

/** Each contribution's extent in the stacked band: positives rightward, negatives leftward. */
function stackBand(values: readonly number[]) {
  const out: { index: number; x: number; w: number }[] = [];
  let right = ZERO_X;
  let left = ZERO_X;
  values.forEach((value, index) => {
    const w = Math.abs(value) * PER;
    if (value >= 0) {
      out.push({ index, x: right, w });
      right += w;
    } else {
      left -= w;
      out.push({ index, x: left, w });
    }
  });
  return out;
}

function RewardContract({
  stage,
  step,
  progress,
}: {
  readonly stage: Stage;
  readonly step: number;
  readonly progress: number;
}) {
  const rows = stage.rewards ?? [];
  const rewards = batchRewards(stage, step, progress);
  const total = rewards.reduce((sum, reward) => sum + reward.value, 0);
  const top = 26;
  const bandY = top + rows.length * ROW_H + 18;
  const height = bandY + 58;
  const signed = (value: number) =>
    `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;

  // Stacked band: positive contributions to the right of zero, the penalty to the left.
  const band = stackBand(rewards.map((reward) => reward.value));

  const label = `Reward contract at step ${number(Math.floor(step))}, simulated batch: ${rewards
    .map(
      (reward, i) =>
        `${reward.name} weight ${reward.weight.toFixed(2)} from ${rows[i]?.source ?? ""}, score ${reward.score.toFixed(2)}, contributes ${signed(reward.value)}`,
    )
    .join("; ")}. Batch total ${signed(total)}.`;

  return (
    <Card
      title={stage.contractTitle}
      icon="contract"
      id="data-contract"
      aside={
        <span className={local.chips}>
          <span className={local.chip} data-kind="sim">
            sim batch
          </span>
          <span className={local.chip}>step {number(Math.floor(step))}</span>
        </span>
      }
    >
      <div
        className={local.scroll}
        tabIndex={0}
        role="region"
        aria-label={`${stage.contractTitle} weights`}
      >
        <svg
          className={local.graph}
          viewBox={`0 0 ${R_W} ${height}`}
          role="img"
          aria-label={label}
        >
          <g className={local.columnHeads} aria-hidden="true">
            <text x={0} y={12}>
              SIGNAL · SOURCE
            </text>
            <text x={420} y={12} textAnchor="end">
              w
            </text>
            <text x={ZERO_X} y={12} textAnchor="middle">
              w · score
            </text>
            <text x={R_W} y={12} textAnchor="end">
              Δ reward
            </text>
          </g>
          {[-0.2, -0.1, 0, 0.1, 0.2].map((tick) => (
            <line
              key={tick}
              className={tick === 0 ? local.zero : local.grid}
              x1={ZERO_X + tick * PER}
              x2={ZERO_X + tick * PER}
              y1={top - 4}
              y2={bandY + 34}
            />
          ))}
          {rows.map((row, index) => {
            const reward = rewards[index]!;
            const y = top + index * ROW_H;
            const outline = Math.abs(row.weight) * PER;
            const fill = Math.abs(reward.value) * PER;
            const negative = row.weight < 0;
            const colour = seriesColour(index);
            return (
              <g key={row.name} className={local.rewardRow}>
                <title>{`${row.name} · ${row.source} · ${row.notes} · score ${reward.score.toFixed(2)}`}</title>
                <text className={local.name} x={0} y={y + 15}>
                  {row.name}
                </text>
                <text className={local.format} x={0} y={y + 30}>
                  {row.source}
                </text>
                <text
                  className={local.count}
                  data-negative={negative || undefined}
                  x={420}
                  y={y + 21}
                  textAnchor="end"
                >
                  {negative ? "−" : ""}
                  {Math.abs(row.weight).toFixed(2)}
                </text>
                <rect
                  className={local.weightBox}
                  x={negative ? ZERO_X - outline : ZERO_X}
                  y={y + 8}
                  width={outline}
                  height={18}
                  style={{ stroke: colour }}
                />
                <rect
                  className={local.contribution}
                  x={negative ? ZERO_X - fill : ZERO_X}
                  y={y + 8}
                  width={fill}
                  height={18}
                  style={{ fill: colour }}
                />
                <text
                  className={local.value}
                  data-negative={negative || undefined}
                  x={R_W}
                  y={y + 21}
                  textAnchor="end"
                >
                  {signed(reward.value)}
                </text>
              </g>
            );
          })}
          <g className={local.total}>
            <text className={local.columnHeads} x={0} y={bandY + 18}>
              Σ BATCH
            </text>
            {band.map(({ index, x, w }) => (
              <rect
                key={index}
                className={local.contribution}
                x={x}
                y={bandY + 4}
                width={w}
                height={22}
                style={{ fill: seriesColour(index) }}
              />
            ))}
            <path
              className={local.net}
              d={`M${ZERO_X + total * PER} ${bandY - 2}V${bandY + 32}`}
            />
            <text className={local.value} x={R_W} y={bandY + 20} textAnchor="end">
              {signed(total)}
            </text>
            {[-0.2, 0, 0.2].map((tick) => (
              <text
                key={tick}
                className={local.format}
                x={ZERO_X + tick * PER}
                y={bandY + 48}
                textAnchor="middle"
              >
                {tick === 0 ? "0" : tick > 0 ? "+0.2" : "−0.2"}
              </text>
            ))}
          </g>
        </svg>
      </div>
    </Card>
  );
}
