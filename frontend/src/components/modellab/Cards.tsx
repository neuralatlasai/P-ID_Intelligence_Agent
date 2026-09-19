"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { hashString } from "@/lib/canvas/engineering";
import { artifactFile } from "@/lib/modellab/artifacts";
import { lastEvalStep, metricAtEval } from "@/lib/modellab/evaluation";
import { checkpointName } from "@/lib/modellab/events";
import { batchRewards } from "@/lib/modellab/ingestion";
import { curveAt, formatAgo, formatDuration, formatSteps } from "@/lib/modellab/run";
import type { CheckId } from "@/lib/modellab/samples";
import { STAGES, type ArtifactSpec, type Stage, type StageId } from "@/lib/modellab/stages";
import { seriesColour } from "@/lib/series";

import local from "./Cards.module.css";
import { Icon, type IconName } from "./icons";
import styles from "./ModelLab.module.css";

/** Technical panel labels avoid assigning unrelated pictograms to model operations. */
const PANEL_LABELS: Partial<Record<IconName, string>> = {
  recipe: "CFG",
  contract: "DATA",
  runtime: "SYS",
  sample: "IN",
  pulse: "RUN",
  metrics: "EVAL",
  checkpoint: "CKPT",
  donut: "MIX",
  target: "OBJ",
  bell: "LOG",
  file: "OUT",
  robot: "KD",
  deploy: "SERVE",
};

const number = (value: number) => value.toLocaleString("en-US");

export function Card({
  title,
  icon,
  aside,
  id,
  className,
  children,
}: {
  readonly title: string;
  readonly icon: IconName;
  readonly aside?: ReactNode;
  readonly id?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={`${styles.card} ${className ?? ""}`} id={id} aria-label={title}>
      <header className={styles.cardHeader}>
        <span className={styles.technicalLabel} aria-hidden="true">
          {PANEL_LABELS[icon] ?? "SPEC"}
        </span>
        <h2>{title}</h2>
        {aside ? <span className={styles.cardAside}>{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * The rendered width of an element, for charts drawn in CSS pixels so their type stays at
 * token size at every viewport instead of scaling with a viewBox.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(200, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A one-word state chip. */
export function Chip({
  tone,
  children,
}: {
  readonly tone?: "sim" | "ok" | "warn" | "run";
  readonly children: ReactNode;
}) {
  return (
    <span className={local.chip} data-tone={tone}>
      {children}
    </span>
  );
}

/** Pass / fail glyph with its verdict for assistive technology. */
export function PassMark({ pass }: { readonly pass: boolean | undefined }) {
  if (pass === undefined) return <span className={local.mark} aria-hidden="true" />;
  return (
    <span
      className={local.mark}
      data-pass={pass}
      role="img"
      aria-label={pass ? "pass" : "fail"}
    >
      <Icon name={pass ? "check" : "cross"} size={12} />
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Teacher and student runtime
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Student rows that are measured by the evaluation harness rather than fixed by the plan. */
const MEASURED_STUDENT_ROWS: Record<
  string,
  { metric: string; format: (v: number) => string }
> = {
  "Weights + KV cache @ 32K": {
    metric: "Serving memory",
    format: (v) => `${v.toFixed(1)} GB`,
  },
  "Decode throughput, batch 1 (H100)": {
    metric: "Decode throughput",
    format: (v) => `${v.toFixed(0)} tok/s`,
  },
  "Time to first token p50, 4K prompt (H100)": {
    metric: "Time to first token p50",
    format: (v) => `${v.toFixed(0)} ms`,
  },
  "Time per output token p95 (H100)": {
    metric: "Time per output token p95",
    format: (v) => `${v.toFixed(1)} ms`,
  },
};

/** Short axis labels for the runtime rows; the full key stays in the accessible table. */
const SHORT_ROW: Record<string, string> = {
  "Weights in memory": "weights",
  "Weights + KV cache @ 32K": "weights + KV 32K",
  "Decode throughput, batch 1 (H100)": "decode",
  "Time to first token p50, 4K prompt (H100)": "TTFT p50",
  "Time per output token p95 (H100)": "TPOT p95",
  "Serving precision": "precision",
  "Context window": "context",
  "Deployment target": "target",
};

/** Rows where a smaller number is the better one. */
const LOWER_IS_BETTER = /memory|KV|Time/i;

function leadingNumber(value: string): number | undefined {
  const match = /^([\d.]+)\s*([A-Za-z/]+)?/.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

function unitOf(value: string): string {
  return /^[\d.]+\s*(.*)$/.exec(value.trim())?.[1] ?? "";
}

/** The three distillation terms, in the order of the stage's total objective. */
const KD_TERMS = [
  { key: "kd-kl", channel: "logits", loss: "fwd KL" },
  { key: "hidden", channel: "hidden", loss: "MSE · W_p" },
  { key: "kd-ce", channel: "traces", loss: "CE" },
] as const;

/**
 * The teacher is a fixed, finished model, so its column is its reference profile. The
 * student is still training: its memory, throughput and latency are the values the last
 * published evaluation measured, identical to the metrics card and the deployment card.
 * Block area is parameter count; channel width is each term's live share of the loss.
 */
export function TeacherStudentRuntimeCard({
  stage,
  step,
}: {
  readonly stage: Stage;
  readonly step: number;
}) {
  const [host, width] = useElementWidth<HTMLDivElement>(520);
  const evalStep = lastEvalStep(stage, step);
  const rows = stage.teacherStudent ?? [];
  const studentValue = (key: string, planned: string): string => {
    const measured = MEASURED_STUDENT_ROWS[key];
    const spec = measured && stage.metrics.find((m) => m.label.startsWith(measured.metric));
    return measured && spec ? measured.format(metricAtEval(spec, stage, step)) : planned;
  };
  const resolved = rows.map(([key, teacher, student]) => ({
    key,
    teacher,
    student: studentValue(key, student),
  }));
  const params = resolved.find((row) => row.key === "Parameters");
  const teacherParams = leadingNumber(params?.teacher ?? "") ?? 1;
  const studentParams = leadingNumber(params?.student ?? "") ?? 1;
  const numeric = resolved.filter(
    (row) =>
      row.key !== "Parameters" &&
      leadingNumber(row.teacher) !== undefined &&
      leadingNumber(row.student) !== undefined &&
      !/window/i.test(row.key),
  );
  const categorical = resolved.filter(
    (row) => row.key !== "Parameters" && !numeric.includes(row),
  );

  // Live loss shares: weight × term value, the same decomposition the curves plot.
  const curves = stage.curves.flatMap((tab) => tab.curves);
  const total = curves.find((curve) => curve.key === "total");
  const terms = KD_TERMS.map((term) => {
    const weight = total?.sumOf?.find((part) => part.key === term.key)?.weight ?? 0;
    const curve = curves.find((item) => item.key === term.key);
    const value = curve ? Math.max(0, curveAt(curve, step, stage)) : 0;
    return { ...term, weight, contribution: weight * value };
  });
  const lossSum = terms.reduce((sum, term) => sum + term.contribution, 0) || 1;

  // ── geometry (CSS px) ────────────────────────────────────────────────────────────────
  const H = 196;
  const teacherSide = Math.min(118, Math.max(64, width * 0.24));
  const studentSide = teacherSide * Math.sqrt(studentParams / teacherParams);
  const tx = 8;
  const ty = 22;
  const sx = width - 8 - studentSide;
  const sy = 22 + (teacherSide - studentSide) / 2;
  const lossX = Math.max(tx + teacherSide + 60, sx - Math.max(44, width * 0.12));
  const lossY = ty + teacherSide / 2;
  const dataY = H - 22;
  const dataX = (tx + teacherSide + lossX) / 2;
  const lane = (share: number) => 1.5 + share * 9;

  const summary =
    `Teacher ${params?.teacher ?? ""} parameters, frozen; student ${params?.student ?? ""} parameters, trained. ` +
    terms
      .map(
        (term) =>
          `${term.channel} channel (${term.loss}) carries ${Math.round((term.contribution / lossSum) * 100)} percent of the loss`,
      )
      .join("; ") +
    `. Student measured at evaluation step ${number(evalStep)}.`;

  return (
    <Card
      title={stage.runtimeTitle}
      icon="runtime"
      aside={<Chip>eval {formatSteps(evalStep)}</Chip>}
    >
      <div ref={host} className={local.figure}>
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={summary}
          className={local.svg}
        >
          <defs>
            <pattern
              id="ts-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" className={local.hatchLine} />
            </pattern>
            <marker
              id="ts-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0 0L8 4L0 8z" className={local.arrowHead} />
            </marker>
          </defs>

          {/* Teacher: frozen, outlined and hatched. */}
          <rect
            x={tx}
            y={ty}
            width={teacherSide}
            height={teacherSide}
            rx={3}
            className={local.frozenBox}
          />
          <rect
            x={tx}
            y={ty}
            width={teacherSide}
            height={teacherSide}
            rx={3}
            fill="url(#ts-hatch)"
          />
          <text x={tx} y={ty - 8} className={local.mono}>
            teacher · {params?.teacher}
          </text>
          <text x={tx + 6} y={ty + teacherSide - 8} className={local.chipText}>
            frozen
          </text>

          {/* Student: trained, solid. */}
          <rect
            x={sx}
            y={sy}
            width={studentSide}
            height={studentSide}
            rx={3}
            className={local.trainBox}
          />
          <text x={sx + studentSide} y={sy - 8} textAnchor="end" className={local.mono}>
            student · {params?.student}
          </text>

          {/* Channels into the loss, width = live share. */}
          {terms.slice(0, 2).map((term, index) => {
            const y0 = ty + teacherSide * (index === 0 ? 0.32 : 0.68);
            const y1 = lossY + (index === 0 ? -5 : 5);
            const share = term.contribution / lossSum;
            const midX = (tx + teacherSide + lossX) / 2;
            return (
              <g key={term.key}>
                <path
                  d={`M${tx + teacherSide},${y0} C${midX},${y0} ${midX},${y1} ${lossX - 12},${y1}`}
                  className={local.forward}
                  strokeWidth={lane(share)}
                />
                {index === 1 ? (
                  <rect
                    x={midX - 11}
                    y={(y0 + y1) / 2 - 7}
                    width={22}
                    height={14}
                    rx={2}
                    className={local.projector}
                  />
                ) : null}
                <text
                  x={midX}
                  y={index === 0 ? Math.min(y0, y1) - 7 : Math.max(y0, y1) + 16}
                  textAnchor="middle"
                  className={local.mono}
                >
                  {term.channel} · {term.loss} · {Math.round(share * 100)}%
                </text>
              </g>
            );
          })}
          {(() => {
            const term = terms[2]!;
            const share = term.contribution / lossSum;
            return (
              <g>
                <rect
                  x={dataX - 26}
                  y={dataY - 9}
                  width={52}
                  height={18}
                  rx={2}
                  className={local.dataBox}
                />
                <text x={dataX} y={dataY + 4} textAnchor="middle" className={local.mono}>
                  traces
                </text>
                <path
                  d={`M${dataX + 26},${dataY} C${lossX},${dataY} ${lossX},${dataY} ${lossX},${lossY + 13}`}
                  className={local.forward}
                  strokeWidth={lane(share)}
                />
                <text x={dataX + 32} y={dataY - 8} className={local.mono}>
                  {term.loss} · {Math.round(share * 100)}%
                </text>
              </g>
            );
          })()}
          {/* Student logits into the loss; gradient back into the student only. */}
          <path
            d={`M${sx},${lossY - 6} L${lossX + 12},${lossY - 6}`}
            className={local.forward}
            strokeWidth={1.5}
          />
          <path
            d={`M${lossX + 12},${lossY + 6} L${sx - 2},${lossY + 6}`}
            className={local.gradient}
            markerEnd="url(#ts-arrow)"
          />
          <circle cx={lossX} cy={lossY} r={12} className={local.lossNode} />
          <text x={lossX} y={lossY + 4} textAnchor="middle" className={local.lossText}>
            L
          </text>
        </svg>
      </div>

      <div
        className={local.pairs}
        role="img"
        aria-label="Teacher and student serving profile, to scale per row"
      >
        {numeric.map((row) => {
          const t = leadingNumber(row.teacher) ?? 0;
          const s = leadingNumber(row.student) ?? 0;
          const max = Math.max(t, s) || 1;
          const better = LOWER_IS_BETTER.test(row.key) ? s <= t : s >= t;
          return (
            <div key={row.key} className={local.pairRow}>
              <span className={local.pairLabel}>{SHORT_ROW[row.key] ?? row.key}</span>
              <span className={local.pairBars}>
                <span className={local.pairTrack}>
                  <i
                    className={local.teacherBar}
                    style={{ width: `${((t / max) * 100).toFixed(1)}%` }}
                  />
                  <b>{row.teacher}</b>
                </span>
                <span className={local.pairTrack}>
                  <i
                    className={local.studentBar}
                    data-better={better || undefined}
                    style={{ width: `${((s / max) * 100).toFixed(1)}%` }}
                  />
                  <b>
                    {s.toLocaleString("en-US", { maximumFractionDigits: 1 })}{" "}
                    {unitOf(row.student)}
                  </b>
                </span>
              </span>
            </div>
          );
        })}
        {categorical.map((row) => (
          <div key={row.key} className={local.pairRow}>
            <span className={local.pairLabel}>{SHORT_ROW[row.key] ?? row.key}</span>
            <span className={local.chipPair}>
              <span className={local.idChip} data-role="teacher">
                {row.teacher}
              </span>
              <span aria-hidden="true" className={local.chipArrow}>
                →
              </span>
              <span className={local.idChip}>{row.student}</span>
            </span>
          </div>
        ))}
      </div>
      <ul className={local.key} aria-hidden="true">
        <li>
          <i data-kind="teacher" /> teacher
        </li>
        <li>
          <i data-kind="student" /> student
        </li>
        <li>
          <i data-kind="forward" /> forward
        </li>
        <li>
          <i data-kind="gradient" /> gradient
        </li>
      </ul>

      <div className="srOnly">
        <table>
          <caption>{stage.runtimeTitle}</caption>
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Teacher</th>
              <th scope="col">Student</th>
            </tr>
          </thead>
          <tbody>
            {resolved.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.key}</th>
                <td>{row.teacher}</td>
                <td>{row.student}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Reward breakdown
// ────────────────────────────────────────────────────────────────────────────────────────────

/** "Grounding consistency reward" → "Grounding"; the full name stays accessible. */
function rewardShort(name: string): string {
  const cleaned = name
    .replace(/2D ↔ 3D\s*/, "")
    .replace(
      /\b(reward|penalty|consistency|validity|faithfulness|outcome|correctness|agreement)\b/gi,
      "",
    )
    .trim();
  const word = cleaned.split(/\s+/)[0] ?? name;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Score ring: arc = batch score, tick = the live carousel score. */
function ScoreRing({
  score,
  live,
  colour,
  penalty,
}: {
  readonly score: number;
  readonly live: number | undefined;
  readonly colour: string;
  readonly penalty: boolean;
}) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const angle = live === undefined ? 0 : clamp(live) * 2 * Math.PI - Math.PI / 2;
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r={r} className={local.ringTrack} />
      <circle
        cx="28"
        cy="28"
        r={r}
        className={local.ringArc}
        data-penalty={penalty || undefined}
        stroke={colour}
        strokeDasharray={`${(c * clamp(score)).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 28 28)"
      />
      {live !== undefined ? (
        <circle
          cx={28 + Math.cos(angle) * r}
          cy={28 + Math.sin(angle) * r}
          r={3}
          className={local.liveDot}
        />
      ) : null}
      <text x="28" y="32" textAnchor="middle" className={local.ringValue}>
        {score.toFixed(2)}
      </text>
    </svg>
  );
}

/**
 * The batch reward, decomposed. Values are the same rows as the reward contract (their sum is
 * the mean reward the curves plot), so the two cards cannot disagree. The live dot on each
 * ring is the verifier's score on the carousel rollouts shown on this page, a small sample
 * that is expected to scatter around the batch figure.
 */
export function RewardBreakdownCard({
  stage,
  step,
  progress,
  checkMeans,
  fabricatedRate,
  liveCount,
}: {
  readonly stage: Stage;
  readonly step: number;
  readonly progress: number;
  readonly checkMeans?: Partial<Record<CheckId, number>>;
  readonly fabricatedRate?: number;
  readonly liveCount: number;
}) {
  const verifierFor = [
    "grounding",
    "topology",
    "registration",
    "citation",
    "simulator",
  ] as const;
  const batch = batchRewards(stage, step, progress);
  const rows = (stage.rewards ?? []).map((reward, index) => {
    // The first five rewards are scored by the verifier checks of the same name, in order.
    const check = verifierFor[index];
    const live =
      reward.weight < 0 ? fabricatedRate : check ? checkMeans?.[check] : undefined;
    const entry = batch[index];
    return {
      reward,
      index,
      value: entry?.value ?? 0,
      score: entry?.score ?? 0,
      live,
    };
  });
  const sum = rows.reduce((acc, row) => acc + row.value, 0);
  const positive = rows.filter((row) => row.value >= 0);
  const negative = rows.filter((row) => row.value < 0);
  const posTotal = positive.reduce((acc, row) => acc + row.value, 0);
  const negTotal = negative.reduce((acc, row) => acc - row.value, 0);
  const span = posTotal + negTotal || 1;
  const zero = (negTotal / span) * 100;
  const at = (value: number) => ((value + negTotal) / span) * 100;

  const before = (list: typeof rows, index: number) =>
    list.slice(0, index).reduce((acc, row) => acc + Math.abs(row.value), 0);
  const segments = positive.map((row, index) => ({
    row,
    left: zero + (before(positive, index) / span) * 100,
    width: (row.value / span) * 100,
  }));
  const penalties = negative.map((row, index) => ({
    row,
    left: zero - ((before(negative, index) - row.value) / span) * 100,
    width: (-row.value / span) * 100,
  }));

  const summary = `Batch mean reward ${sum.toFixed(3)}: ${rows
    .map(
      (row) =>
        `${row.reward.name} ${row.value >= 0 ? "+" : "−"}${Math.abs(row.value).toFixed(3)}`,
    )
    .join(", ")}`;

  return (
    <Card
      title="Reward breakdown"
      icon="chart"
      aside={
        <span className={local.asideValue}>
          <span>Σ</span>
          <b>{sum.toFixed(3)}</b>
        </span>
      }
    >
      <div className={local.stack}>
        <div className={local.stackTrack} role="img" aria-label={summary}>
          {[...penalties, ...segments].map(({ row, left, width }) => (
            <i
              key={row.reward.name}
              data-penalty={row.value < 0 || undefined}
              style={{
                left: `${left.toFixed(2)}%`,
                width: `${width.toFixed(2)}%`,
                background: seriesColour(row.index),
              }}
              title={`${row.reward.name}: ${row.value >= 0 ? "+" : "−"}${Math.abs(row.value).toFixed(3)}`}
            />
          ))}
          <b className={local.zero} style={{ left: `${zero.toFixed(2)}%` }} />
          <b className={local.net} style={{ left: `${at(sum).toFixed(2)}%` }} />
        </div>
        <div className={local.stackAxis} aria-hidden="true">
          <span style={{ left: "0%" }}>−{negTotal.toFixed(2)}</span>
          <span style={{ left: `${zero.toFixed(2)}%` }}>0</span>
          <span style={{ left: `${at(sum).toFixed(2)}%` }} data-net>
            Σ {sum.toFixed(3)}
          </span>
          <span style={{ left: "100%" }}>+{posTotal.toFixed(2)}</span>
        </div>
      </div>

      <ul className={local.rings}>
        {rows.map((row) => (
          <li
            key={row.reward.name}
            aria-label={`${row.reward.name}: weight ${row.reward.weight}, batch score ${row.score.toFixed(2)}, contribution ${row.value.toFixed(3)}${row.live === undefined ? "" : `, live score on ${liveCount} rollouts ${row.live.toFixed(2)}`}`}
          >
            <ScoreRing
              score={row.score}
              live={row.live}
              colour={seriesColour(row.index)}
              penalty={row.value < 0}
            />
            <span className={local.ringName}>{rewardShort(row.reward.name)}</span>
            <span className={local.ringWeight} data-negative={row.value < 0 || undefined}>
              {row.value >= 0 ? "+" : "−"}
              {Math.abs(row.value).toFixed(3)}
            </span>
          </li>
        ))}
      </ul>
      <ul className={local.key} aria-hidden="true">
        <li>
          <i data-kind="arc" /> batch score
        </li>
        <li>
          <i data-kind="live" /> live ({liveCount})
        </li>
        <li>
          <i data-kind="net" /> Σ mean
        </li>
      </ul>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Artifacts
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Seconds an artifact takes to write, whatever the run's step rate. */
const WRITE_SECONDS = 240;

type ArtifactState = "queued" | "writing" | "emitted" | "verified" | "tracking";

const STATE_LABEL: Record<ArtifactState, string> = {
  queued: "Queued",
  writing: "Writing",
  emitted: "Emitted",
  verified: "Verified",
  tracking: "Tracking",
};

/** The output of each stage that the next stage starts from. */
const HANDOFF: Record<StageId, string> = {
  pretraining: "checkpoint",
  sft: "assistant",
  rl: "candidate",
  distillation: "quant",
};

const SHORT_STAGE: Record<StageId, string> = {
  pretraining: "pretrain",
  sft: "SFT",
  rl: "RL",
  distillation: "distill",
};

/** A stable, clearly simulated digest: same stage, artifact and step always give the same one. */
function digest(stage: Stage, spec: ArtifactSpec, step: number): string {
  const a = hashString(`${stage.id}:${spec.id}:${step}`).toString(16).padStart(8, "0");
  const b = hashString(`${spec.id}:${step}:${stage.experimentId}`)
    .toString(16)
    .padStart(8, "0");
  return `${a}${b}`;
}

function clockTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A size in GB parsed from an artifact's text, falling back to the run's checkpoint size. */
function sizeOf(spec: ArtifactSpec, stage: Stage): number | undefined {
  const text = `${spec.detail} ${spec.subtitle}`;
  const match = /([\d.]+)\s*(TB|GB|MB)\b/.exec(text);
  if (match) {
    const value = Number(match[1]);
    return match[2] === "TB" ? value * 1024 : match[2] === "MB" ? value / 1024 : value;
  }
  if (spec.download === "weights") {
    const run = /([\d.]+)\s*GB/.exec(stage.run.checkpointSize);
    return run ? Number(run[1]) : undefined;
  }
  return undefined;
}

function formatSize(gb: number | undefined): string {
  if (gb === undefined) return "";
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/** The artifact's name in the experiment directory: its identifier, or a slug of its title. */
function fileName(spec: ArtifactSpec, stage: Stage): string {
  if (spec.download && spec.download !== "weights") {
    const generated = GENERATED_NAME[spec.download];
    if (generated) return generated(stage);
  }
  const id = /^[\w.-]+$/.test(spec.subtitle) && spec.subtitle !== "experiment";
  if (id)
    return spec.download === "weights" && !/\./.test(spec.subtitle)
      ? `${spec.subtitle}/`
      : spec.subtitle;
  if (spec.download === "weights" && spec.subtitle === "experiment") {
    return `${checkpointName(stage.run.totalSteps)}/`;
  }
  const slug = spec.title
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return spec.download === "weights" || !spec.download ? `${slug}/` : slug;
}

const GENERATED_NAME: Partial<
  Record<NonNullable<ArtifactSpec["download"]>, (stage: Stage) => string>
> = {
  manifest: (stage) =>
    stage.id === "sft" ? "tool-call-policy.yaml" : "inference-manifest.yaml",
  "serving-config": () => "tensorrt-llm-config.json",
  profile: () => "plant-profile-v1.0.json",
  "behavior-profile": () => "behavior-profile-v1.0.json",
};

/** Progress ring: a small SVG circle filled to `share`. */
function Ring({ share, label }: { readonly share: number; readonly label: string }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <span className={styles.ring} role="img" aria-label={label}>
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle cx="17" cy="17" r={r} className={styles.ringTrack} />
        <circle
          cx="17"
          cy="17"
          r={r}
          className={styles.ringFill}
          strokeDasharray={`${(c * Math.min(1, Math.max(0, share))).toFixed(2)} ${c.toFixed(2)}`}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <b>{Math.floor(share * 100)}%</b>
    </span>
  );
}

/** One arrow of the handoff graph: stroke width is the size it carries. */
function Edge({
  gb,
  live,
  label,
}: {
  readonly gb: number | undefined;
  readonly live: boolean;
  readonly label?: string;
}) {
  const w = gb === undefined ? 1.5 : Math.min(9, 1.5 + Math.sqrt(gb) * 0.9);
  return (
    <span className={local.edge} data-live={live || undefined}>
      <svg viewBox="0 0 60 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 10H50" strokeWidth={w} className={local.edgeLine} />
        <path d="M50 3L60 10L50 17z" className={local.edgeHead} />
      </svg>
      {label ? <b>{label}</b> : null}
    </span>
  );
}

export function ArtifactsRow({
  stage,
  progress,
  step,
  sheet,
  verifications,
  now,
  running,
}: {
  readonly stage: Stage;
  readonly progress: number;
  readonly step: number;
  readonly sheet: string;
  readonly verifications: readonly {
    readonly tag: string;
    readonly overall: number;
    readonly pass: boolean;
  }[];
  readonly now: number;
  readonly running: boolean;
}) {
  const { run } = stage;
  const passRate = verifications.length
    ? verifications.filter((item) => item.pass).length / verifications.length
    : 0;
  const allReady = stage.outputs.every((output) => progress >= output.readyAt);
  const emittedCount = stage.outputs.filter((output) => progress >= output.readyAt).length;
  const download = (spec: ArtifactSpec) => {
    const file = artifactFile(spec, {
      stage,
      step,
      progress,
      generatedAt: new Date().toISOString(),
      sheet,
      verifierPassRate: passRate,
      samples: verifications,
    });
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.body], { type: file.type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // Rolling checkpoint writes: where the current shard write is, and when the next one lands.
  const lastCheckpoint = Math.floor(step / run.checkpointEvery) * run.checkpointEvery;
  const toNext = Math.min(run.totalSteps, lastCheckpoint + run.checkpointEvery) - step;
  const cycleShare = 1 - toNext / run.checkpointEvery;

  const stateOf = (spec: ArtifactSpec) => {
    const readyStep = spec.readyAt * run.totalSteps;
    const window = Math.max(1, WRITE_SECONDS * run.stepsPerSecond);
    const secondsSince = (step - readyStep) / run.stepsPerSecond;
    let state: ArtifactState;
    if (spec.readyAt === 0) state = "tracking";
    else if (step >= readyStep) state = secondsSince > 90 ? "verified" : "emitted";
    else if (readyStep - step <= window) state = "writing";
    else state = "queued";
    const writeShare = state === "writing" ? 1 - (readyStep - step) / window : 0;
    return { state, readyStep, secondsSince, writeShare };
  };

  // ── handoff graph ────────────────────────────────────────────────────────────────────
  const index = STAGES.findIndex((item) => item.id === stage.id);
  const previous = index > 0 ? STAGES[index - 1] : undefined;
  const next = index >= 0 ? STAGES[index + 1] : undefined;
  const inputSpec = previous?.outputs.find((spec) => spec.id === HANDOFF[previous.id]);
  const inputSize = previous && inputSpec ? sizeOf(inputSpec, previous) : undefined;
  const inputName = previous
    ? `${previous.number} ${SHORT_STAGE[previous.id]}`
    : ((stage.recipe.find((row) => row.key === "Backbone VLM")?.value as
        string | undefined) ?? "base");
  const weights = stage.outputs.filter((spec) => spec.download === "weights");
  const handoff = stage.outputs.find((spec) => spec.id === HANDOFF[stage.id]);
  const handoffState = handoff ? stateOf(handoff).state : "queued";
  const handoffLive = handoffState === "emitted" || handoffState === "verified";
  const handoffSize = handoff ? sizeOf(handoff, stage) : undefined;
  const nextName = next ? `${next.number} ${SHORT_STAGE[next.id]}` : "serve";
  const graphLabel =
    `Checkpoint handoff: ${inputName}${inputSize ? ` (${formatSize(inputSize)})` : ""} into stage ${stage.number}, ` +
    weights
      .map(
        (spec) =>
          `${spec.title} ${formatSize(sizeOf(spec, stage))} ${STATE_LABEL[stateOf(spec).state].toLowerCase()}`,
      )
      .join(", ") +
    `, handed to ${nextName}${handoffLive ? "" : " once emitted"}.`;

  return (
    <Card
      title={stage.outputsTitle}
      icon="file"
      className={styles.outputs}
      aside={
        <span className={local.asideValue}>
          <b>
            {emittedCount}/{stage.outputs.length}
          </b>
          <Chip tone={allReady ? "ok" : running ? "run" : "warn"}>
            {allReady ? "ready" : running ? "emitting" : "paused"}
          </Chip>
        </span>
      }
    >
      <div className={local.handoff} role="img" aria-label={graphLabel}>
        <div className={local.node} data-kind="input">
          <span className={local.nodeTag}>in</span>
          <code>{inputName}</code>
        </div>
        <div className={local.edgeCell}>
          <Edge gb={inputSize} live label={formatSize(inputSize)} />
        </div>
        <div className={local.node} data-kind="run">
          <span className={local.nodeTag}>{stage.number}</span>
          <code>{SHORT_STAGE[stage.id]}</code>
          <span className={local.nodeBar}>
            <i style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%` }} />
          </span>
        </div>
        <div className={local.edgeCell}>
          <Edge gb={undefined} live={weights.some((spec) => progress >= spec.readyAt)} />
        </div>
        <div className={local.fan}>
          {weights.map((spec) => {
            const { state } = stateOf(spec);
            return (
              <span
                key={spec.id}
                className={local.node}
                data-kind="weights"
                data-state={state}
                data-handoff={spec.id === handoff?.id || undefined}
              >
                <code>{fileName(spec, stage)}</code>
                <b>{formatSize(sizeOf(spec, stage))}</b>
              </span>
            );
          })}
        </div>
        <div className={local.edgeCell}>
          <Edge gb={handoffSize} live={handoffLive} label={formatSize(handoffSize)} />
        </div>
        <div className={local.node} data-kind="next" data-live={handoffLive || undefined}>
          <span className={local.nodeTag}>out</span>
          <code>{nextName}</code>
        </div>
      </div>

      <div
        className={local.tree}
        role="group"
        aria-label={`${stage.experimentId} artifacts`}
      >
        <code className={local.treeRoot}>{stage.experimentId}/</code>
        <ul>
          {stage.outputs.map((spec) => {
            const { state, readyStep, secondsSince, writeShare } = stateOf(spec);
            const isWeights = spec.download === "weights";
            const hash = digest(stage, spec, Math.round(readyStep));
            const fresh =
              (state === "emitted" || state === "verified") && secondsSince < 600;
            const size = sizeOf(spec, stage);
            let meta: ReactNode;
            switch (state) {
              case "queued":
                meta = (
                  <span
                    className={local.metaMono}
                    title={`Due at step ${number(Math.round(readyStep))}`}
                  >
                    T−{formatDuration((readyStep - step) / run.stepsPerSecond)}
                  </span>
                );
                break;
              case "writing":
                meta = (
                  <span className={styles.writeBar} data-running={running || undefined}>
                    <i style={{ width: `${(writeShare * 100).toFixed(1)}%` }} />
                  </span>
                );
                break;
              case "emitted":
              case "verified":
                meta = (
                  <span
                    className={local.metaMono}
                    title={`${STATE_LABEL[state]} ${formatAgo(secondsSince)} · ${clockTime(now - secondsSince * 1000)} · step ${number(Math.round(readyStep))}. Content digest of the simulated artifact record; no weights exist behind it.`}
                  >
                    sha256:{hash.slice(0, 8)}
                  </span>
                );
                break;
              case "tracking":
                meta = <span className={local.metaMono}>step {formatSteps(step)}</span>;
                break;
            }
            return (
              <li
                key={spec.id}
                data-state={state}
                data-fresh={fresh || undefined}
                title={`${spec.title} — ${spec.subtitle} · ${spec.detail}`}
              >
                <code className={local.fileName}>
                  <span
                    className={local.fileGlyph}
                    aria-hidden="true"
                    data-dir={fileName(spec, stage).endsWith("/") || undefined}
                  />
                  {fileName(spec, stage)}
                  <span className="srOnly"> ({spec.title})</span>
                </code>
                <span className={local.fileSize}>{formatSize(size)}</span>
                <span className={styles.stateChip} data-state={state}>
                  <i aria-hidden="true" />
                  {STATE_LABEL[state]}
                </span>
                <span className={local.fileMeta}>{meta}</span>
                <span className={local.fileAction}>
                  {state === "queued" ? (
                    <Ring
                      share={step / readyStep}
                      label={`${spec.title}: ${Math.floor((step / readyStep) * 100)} percent of the way to emission`}
                    />
                  ) : spec.download && !isWeights ? (
                    <button
                      className={styles.downloadButton}
                      disabled={state === "writing"}
                      onClick={() => download(spec)}
                      title={
                        state === "writing"
                          ? "Being written"
                          : "Download the generated file"
                      }
                      aria-label={`Download ${spec.title}`}
                    >
                      <Icon name="download" size={16} />
                    </button>
                  ) : isWeights ? (
                    <button
                      className={styles.downloadButton}
                      disabled
                      title="No weights exist: this is a simulated run, so nothing was trained."
                      aria-label={`${spec.title}: weights not available from a simulated run`}
                    >
                      <Icon name="download" size={16} />
                    </button>
                  ) : (
                    <span
                      className={styles.readyMark}
                      data-ready
                      role="img"
                      aria-label={STATE_LABEL[state]}
                    >
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </span>
                {isWeights && state !== "writing" ? (
                  <span
                    className={local.cycle}
                    data-running={running || undefined}
                    title={`Checkpoint write cycle: ${Math.floor(cycleShare * 100)}% to step ${number(lastCheckpoint + run.checkpointEvery)}`}
                    aria-hidden="true"
                  >
                    <i style={{ width: `${(cycleShare * 100).toFixed(1)}%` }} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
