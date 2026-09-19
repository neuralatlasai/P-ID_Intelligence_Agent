"use client";

import { useId, useMemo, type ReactNode } from "react";

import { learningRateAt } from "@/lib/modellab/run";
import { seriesColour } from "@/lib/series";

import { Card } from "./Cards";
import {
  batchGeometry,
  parameterBudget,
  scheduleSeries,
  type BatchGeometry,
  type ParameterPart,
} from "./flow/stepFlow";
import type { LiveCardProps } from "./live";
import css from "./RecipeLiveCard.module.css";

/*
 * The stage recipe drawn rather than listed. Four glyphs, each an instrument reading of the
 * applied configuration: what the optimizer may change (parameters by role), how one step's
 * batch is laid over the cluster, where the run is on its learning-rate schedule, and what
 * the data (or, for RL, the reward) is made of. Identifiers and numbers are mono; every
 * glyph's full reading is its accessible name.
 */

const fmtB = (billions: number) =>
  billions >= 10
    ? `${billions.toFixed(1)}B`
    : billions >= 1
      ? `${billions.toFixed(2)}B`
      : `${(billions * 1000).toFixed(0)}M`;
const grouped = (value: number) => Math.round(value).toLocaleString("en-US");
const compact = (value: number) =>
  value >= 1e6
    ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 2)}M`
    : value >= 1e3
      ? `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`
      : grouped(value);

const PART_NAME: Record<ParameterPart["id"], string> = {
  base: "base",
  lora: "LoRA",
  encoders: "enc",
  teacher: "teacher",
};

// ── parameters by role ───────────────────────────────────────────────────────────────────

/** Lay parts end to end along a bar: each part's x and width at `scale`, `gap` between. */
function lay(
  parts: readonly ParameterPart[],
  scale: number,
  gap: number,
): { readonly part: ParameterPart; readonly x: number; readonly w: number }[] {
  const out: { part: ParameterPart; x: number; w: number }[] = [];
  let x = 0;
  for (const part of parts) {
    const w = Math.max(2, part.billions * scale - gap);
    out.push({ part, x, w });
    x += w + gap;
  }
  return out;
}

function Parameters({ parts }: { readonly parts: readonly ParameterPart[] }) {
  const W = 320;
  // Frozen weights carry the figures' hatch; the pattern is this glyph's own.
  const hatchId = `recipe-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hatch = { fill: `url(#${hatchId})` };
  const own = parts.filter((part) => part.id !== "teacher");
  const teacher = parts.find((part) => part.id === "teacher");
  const trainable = own.filter((part) => part.trainable);
  const ownTotal = own.reduce((sum, part) => sum + part.billions, 0);
  const trainTotal = trainable.reduce((sum, part) => sum + part.billions, 0);
  // One scale for the model (and the teacher, when there is one), so size compares directly.
  const scale = W / Math.max(ownTotal, teacher?.billions ?? 0);
  const gap = 2;
  const rowH = 16;
  let y = 4;
  const rows: ReactNode[] = [];
  if (teacher) {
    rows.push(
      <g key="teacher">
        <rect
          className={css.frozen}
          x={0.5}
          y={y}
          width={teacher.billions * scale - 1}
          height={rowH}
        />
        <rect
          className={css.hatch}
          style={hatch}
          x={0.5}
          y={y}
          width={teacher.billions * scale - 1}
          height={rowH}
        />
        <text className={css.label} x={0} y={y + rowH + 12}>
          teacher {fmtB(teacher.billions)}
        </text>
      </g>,
    );
    y += rowH + 22;
  }
  const segments = lay(own, scale, gap);
  rows.push(
    <g key="model">
      {segments.map(({ part, x: sx, w }) =>
        part.trainable ? (
          <rect
            key={part.id}
            className={css.trained}
            x={sx}
            y={y}
            width={w}
            height={rowH}
          />
        ) : (
          <g key={part.id}>
            <rect className={css.frozen} x={sx + 0.5} y={y} width={w - 1} height={rowH} />
            <rect
              className={css.hatch}
              style={hatch}
              x={sx + 0.5}
              y={y}
              width={w - 1}
              height={rowH}
            />
          </g>
        ),
      )}
    </g>,
  );
  y += rowH;
  const frozenOwn = ownTotal - trainTotal;
  rows.push(
    <g key="model-labels">
      <text className={css.label} x={0} y={y + 13}>
        frozen {frozenOwn > 0 ? fmtB(frozenOwn) : "—"}
      </text>
      <text className={css.label} x={W} y={y + 13} textAnchor="end">
        Σ {fmtB(ownTotal)}
      </text>
    </g>,
  );
  // The trainable share, magnified to full width: what the optimizer state is sized by.
  const zoomY = y + 30;
  const trainScale = trainTotal > 0 ? W / trainTotal : 0;
  const zoom = lay(trainable, trainScale, gap);
  const firstTrainable = segments.find((segment) => segment.part.trainable);
  const lastTrainable = [...segments].reverse().find((segment) => segment.part.trainable);
  const height = zoomY + rowH + 30;
  return (
    <svg
      className={css.glyph}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`Parameters: ${own
        .map(
          (part) =>
            `${PART_NAME[part.id]} ${fmtB(part.billions)} ${part.trainable ? "trainable" : "frozen"}`,
        )
        .join(
          ", ",
        )}${teacher ? `; frozen teacher ${fmtB(teacher.billions)}` : ""}; ${fmtB(trainTotal)} trainable, ${((100 * trainTotal) / ownTotal).toFixed(1)} percent`}
    >
      <defs>
        <pattern
          id={hatchId}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <path d="M0 0V6" className={css.hatchLine} />
        </pattern>
      </defs>
      {rows}
      {firstTrainable && lastTrainable && trainTotal < ownTotal && (
        // Projection lines from the trainable slice to its magnified bar.
        <path
          className={css.projection}
          d={`M${firstTrainable.x},${y} L0,${zoomY} M${lastTrainable.x + lastTrainable.w},${y} L${W},${zoomY}`}
        />
      )}
      {zoom.map(({ part, x: sx, w }, index) => (
        <g key={part.id}>
          <rect
            className={css.trained}
            data-part={index}
            x={sx}
            y={zoomY}
            width={w}
            height={rowH}
          />
          {w > 44 && (
            <text className={css.inBar} x={sx + 5} y={zoomY + 12}>
              {PART_NAME[part.id]}
            </text>
          )}
        </g>
      ))}
      <text className={css.value} x={0} y={zoomY + rowH + 16}>
        ∇ {fmtB(trainTotal)} · {((100 * trainTotal) / ownTotal).toFixed(1)}%
      </text>
    </svg>
  );
}

// ── batch geometry ───────────────────────────────────────────────────────────────────────

function Batch({ geometry }: { readonly geometry: BatchGeometry }) {
  const W = 320;
  const shownNodes = Math.min(geometry.nodes, 8);
  const perNode = Math.min(geometry.gpusPerNode, 8);
  const cell = 6;
  const nodeW = perNode * (cell + 2) + 6;
  const nodesPerRow = Math.max(1, Math.floor(166 / (nodeW + 6)));
  const nodeRows = Math.ceil(shownNodes / nodesPerRow);
  const clusterH = nodeRows * (cell + 12) - 4;
  // Right: one rank's step, accumulation slices of micro × sequence, stacked back to front.
  const slices = Math.min(geometry.accumulation, 8);
  const tx = 176;
  const tw = W - tx - slices * 4;
  const th = 10 + geometry.micro * 8;
  const height = Math.max(clusterH, th + slices * 4) + 40;
  return (
    <svg
      className={css.glyph}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`Batch: ${geometry.nodes} nodes × ${geometry.gpusPerNode} GPUs = ${geometry.ranks} ranks; ${geometry.micro} sequence${geometry.micro > 1 ? "s" : ""} per micro-batch, ${geometry.accumulation} micro-batches accumulated per rank; ${geometry.globalBatch} ${geometry.group > 1 ? `prompts × ${geometry.group} completions` : "sequences"} of ${grouped(geometry.sequence)} tokens; ${grouped(geometry.tokensPerStep)} tokens per step`}
    >
      {Array.from({ length: shownNodes }, (_, n) => {
        const nx = (n % nodesPerRow) * (nodeW + 6);
        const ny = Math.floor(n / nodesPerRow) * (cell + 12);
        return (
          <g key={n} transform={`translate(${nx} ${ny + 2})`}>
            <rect className={css.node} width={nodeW} height={cell + 6} rx={1.5} />
            {Array.from({ length: perNode }, (_, g) => (
              <rect
                key={g}
                className={css.gpu}
                x={3 + g * (cell + 2)}
                y={3}
                width={cell}
                height={cell}
              />
            ))}
          </g>
        );
      })}
      {Array.from({ length: slices }, (_, k) => {
        const back = slices - 1 - k;
        return (
          <g key={k} transform={`translate(${tx + back * 4} ${2 + back * 4})`}>
            <rect
              className={k === slices - 1 ? css.slice : css.sliceBack}
              width={tw}
              height={th}
            />
            {k === slices - 1 &&
              Array.from({ length: geometry.micro }, (_, m) => (
                <rect
                  key={m}
                  className={css.sequence}
                  x={4}
                  y={5 + m * 8}
                  width={tw - 8}
                  height={5}
                />
              ))}
          </g>
        );
      })}
      <text className={css.value} x={0} y={height - 20}>
        {geometry.nodes}×{geometry.gpusPerNode} GPU
      </text>
      <text className={css.value} x={tx} y={height - 20}>
        {geometry.micro} × {grouped(geometry.sequence)} · acc {geometry.accumulation}
      </text>
      <text className={css.label} x={0} y={height - 4}>
        {geometry.ranks}·{geometry.micro}·{geometry.accumulation} = {geometry.globalBatch}
        {geometry.group > 1 ? ` × G${geometry.group}` : ""}
      </text>
      <text className={css.label} x={W} y={height - 4} textAnchor="end">
        {compact(geometry.tokensPerStep)} tok/step
      </text>
    </svg>
  );
}

// ── learning-rate schedule ───────────────────────────────────────────────────────────────

function Schedule({
  stage,
  step,
}: {
  readonly stage: LiveCardProps["stage"];
  readonly step: number;
}) {
  const W = 320;
  const H = 92;
  const pad = { top: 16, bottom: 22 };
  const series = useMemo(() => scheduleSeries(stage.run), [stage.run]);
  const peak = stage.run.learningRate;
  const total = stage.run.totalSteps;
  const x = (s: number) => (W * s) / Math.max(1, total);
  const y = (lr: number) => pad.top + (H - pad.top - pad.bottom) * (1 - lr / peak);
  // The step executing now, as figure 03 and the gauges under its optimizer box read it.
  const now = Math.min(total, Math.floor(Math.max(0, step)) + 1);
  const lr = learningRateAt(stage.run, now);
  const d = `M${series.map((p) => `${x(p.step).toFixed(1)},${y(p.lr).toFixed(1)}`).join(" L")}`;
  const done = series.filter((p) => p.step <= now);
  const doneD = `M${[...done, { step: now, lr }]
    .map((p) => `${x(p.step).toFixed(1)},${y(p.lr).toFixed(1)}`)
    .join(" L")}`;
  return (
    <svg
      className={css.glyph}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Schedule: AdamW, linear warmup over ${grouped(stage.run.warmupSteps)} steps to ${peak.toExponential(1)}, cosine decay to ${(peak * 0.1).toExponential(1)} at step ${grouped(total)}; now step ${grouped(now)}, learning rate ${lr.toExponential(2)}`}
    >
      <path className={css.baseline} d={`M0,${H - pad.bottom} H${W}`} />
      <path className={css.schedule} d={d} />
      <path className={css.scheduleDone} d={doneD} />
      <path className={css.now} d={`M${x(now)},${pad.top - 6} V${H - pad.bottom}`} />
      <circle className={css.nowDot} cx={x(now)} cy={y(lr)} r={3.4} />
      <text
        className={css.value}
        x={Math.min(W - 2, Math.max(2, x(now)))}
        y={pad.top - 8}
        textAnchor={x(now) > W * 0.6 ? "end" : "start"}
      >
        {lr.toExponential(2)}
      </text>
      <text className={css.label} x={0} y={H - 6}>
        0
      </text>
      <text className={css.label} x={x(stage.run.warmupSteps) + 4} y={H - 6}>
        ↑{grouped(stage.run.warmupSteps)}
      </text>
      <text className={css.label} x={W} y={H - 6} textAnchor="end">
        {grouped(total)}
      </text>
    </svg>
  );
}

// ── data (or reward) composition ─────────────────────────────────────────────────────────

interface Slice {
  readonly id: string;
  readonly name: string;
  readonly share: number;
  readonly value: string;
  readonly penalty?: boolean;
}

function Ring({
  slices,
  centre,
  unit,
  label,
}: {
  readonly slices: readonly Slice[];
  readonly centre: string;
  readonly unit: string;
  readonly label: string;
}) {
  const R = 38;
  const r = 26;
  const C = 44;
  const starts = slices.map((_, index) =>
    slices.slice(0, index).reduce((sum, item) => sum + item.share, 0),
  );
  const arcs = slices.map((slice, index) => {
    const sweep = 2 * Math.PI * slice.share;
    const angle = -Math.PI / 2 + 2 * Math.PI * starts[index]!;
    const a0 = angle + 0.012;
    const a1 = angle + sweep - 0.012;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, radius: number) =>
      `${(C + radius * Math.cos(rad)).toFixed(2)},${(C + radius * Math.sin(rad)).toFixed(2)}`;
    return {
      slice,
      index,
      d: `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`,
    };
  });
  return (
    <div className={css.ring} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${2 * C} ${2 * C}`} aria-hidden="true">
        {arcs.map(({ slice, index, d }) => (
          <path
            key={slice.id}
            d={d}
            className={css.arc}
            data-penalty={slice.penalty || undefined}
            style={{ fill: seriesColour(index), stroke: seriesColour(index) }}
          />
        ))}
        <text className={css.ringValue} x={C} y={C + 2}>
          {centre}
        </text>
        <text className={css.ringUnit} x={C} y={C + 13}>
          {unit}
        </text>
      </svg>
      <ul aria-hidden="true">
        {slices.map((slice, index) => (
          <li key={slice.id}>
            <i
              data-penalty={slice.penalty || undefined}
              style={
                slice.penalty
                  ? { borderColor: seriesColour(index) }
                  : { background: seriesColour(index) }
              }
            />
            <span>{slice.name}</span>
            <b>{slice.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Contract names as a ring legend prints them. */
const DATA_NAME: Record<string, string> = {
  pid: "P&ID",
  graph: "GraphML",
  images: "RGB",
  "3d": "CAD/points",
  ts: "series",
  docs: "docs",
  packages: "packages",
  alignment: "alignment",
  procedural: "proc. QA",
  topology: "topology",
  anomaly: "anomaly",
  telemetry: "telemetry",
  traces: "traces",
  rollouts: "rollouts",
  correspondences: "field→P&ID",
  simulation: "simulation",
  extraction: "extraction",
  dialogues: "dialogues",
};

const VERIFIER_NAME: Record<string, string> = {
  "Grounded parser": "parser",
  "Topology validator": "topology",
  "Vision-geometry matcher": "geometry",
  "Citation checker": "citations",
  "Process simulator": "simulator",
  "Verifier + GT labels": "abstention",
  "Verifier ensemble": "hallucination",
};

/** Identifier chips: the recipe's names, as names. */
function identifiers(props: LiveCardProps): string[] {
  const { stage, config, profile } = props;
  const chips = [
    profile.backbone.name,
    config.precision.toUpperCase(),
    `${profile.backbone.contextK}K ctx`,
    config.trainable === "full" ? "full FT" : stage.id === "rl" ? "LoRA r64" : "LoRA",
  ];
  if (stage.id === "sft") chips.unshift("init ← 01");
  if (stage.id === "rl") chips.unshift("init ← 02", "verl", "GRPO", "k3 · β 0.001");
  if (stage.id === "distillation") chips.unshift("teacher ← 03", "KD T=2");
  return chips;
}

export function RecipeLiveCard(props: LiveCardProps) {
  const { stage, step, config, profile } = props;
  const parts = useMemo(
    () => parameterBudget(stage.id, config, profile),
    [stage.id, config, profile],
  );
  const geometry = useMemo(
    () => batchGeometry(stage.id, config, profile),
    [stage.id, config, profile],
  );
  const ring = useMemo(() => {
    if (stage.id === "rl") {
      const rewards = stage.rewards ?? [];
      const total = rewards.reduce((sum, reward) => sum + Math.abs(reward.weight), 0) || 1;
      return {
        title: "verifiers",
        slices: rewards.map((reward) => ({
          id: reward.name,
          name: VERIFIER_NAME[reward.source] ?? reward.source,
          share: Math.abs(reward.weight) / total,
          value: `${reward.weight < 0 ? "−" : "+"}${Math.abs(reward.weight).toFixed(2)}`,
          penalty: reward.weight < 0,
        })),
        centre: `${rewards.length}`,
        unit: "rewards",
        label: `Reward composition: ${rewards
          .map((reward) => `${reward.source} ${reward.weight.toFixed(2)}`)
          .join(", ")}`,
      };
    }
    const total = stage.contract.reduce((sum, row) => sum + row.target, 0) || 1;
    return {
      title: "data",
      slices: stage.contract.map((row) => ({
        id: row.id,
        name: DATA_NAME[row.id] ?? row.name,
        share: row.target / total,
        value:
          row.target / total < 0.001
            ? "<0.1%"
            : `${((100 * row.target) / total).toFixed(row.target / total < 0.01 ? 1 : 0)}%`,
      })),
      centre: compact(total),
      unit: "samples",
      label: `Data mixture by planned samples: ${stage.contract
        .map((row) => `${row.name} ${row.targetLabel}`)
        .join(", ")}`,
    };
  }, [stage]);

  return (
    <Card title={stage.recipeTitle} icon="recipe">
      <ul className={css.chips} aria-label="Recipe identifiers">
        {identifiers(props).map((chip) => (
          <li key={chip}>{chip}</li>
        ))}
      </ul>
      <div className={css.grid}>
        <figure className={css.panel}>
          <figcaption>params</figcaption>
          <Parameters parts={parts} />
        </figure>
        <figure className={css.panel}>
          <figcaption>batch</figcaption>
          <Batch geometry={geometry} />
        </figure>
        <figure className={css.panel}>
          <figcaption>AdamW · lr</figcaption>
          <Schedule stage={stage} step={step} />
        </figure>
        <figure className={css.panel}>
          <figcaption>{ring.title}</figcaption>
          <Ring
            slices={ring.slices}
            centre={ring.centre}
            unit={ring.unit}
            label={ring.label}
          />
        </figure>
      </div>
    </Card>
  );
}
