"use client";

import type { ReactNode } from "react";

import { hashString } from "@/lib/canvas/engineering";
import { artifactFile } from "@/lib/modellab/artifacts";
import { lastEvalStep, metricAtEval } from "@/lib/modellab/evaluation";
import { batchRewards } from "@/lib/modellab/ingestion";
import { formatAgo, formatDuration, formatSteps } from "@/lib/modellab/run";
import type { CheckId } from "@/lib/modellab/samples";
import type { ArtifactSpec, Stage } from "@/lib/modellab/stages";

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

// ────────────────────────────────────────────────────────────────────────────────────────────
// Teacher and student runtime
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Student rows that are measured by the evaluation harness rather than fixed by the plan. */
const MEASURED_STUDENT_ROWS: Record<
  string,
  { metric: string; format: (v: number) => string }
> = {
  "VRAM footprint": { metric: "Peak VRAM", format: (v) => `${v.toFixed(1)} GB` },
  "Throughput (tokens/s)": { metric: "Throughput", format: (v) => v.toFixed(1) },
  "Latency (per sample)": {
    metric: "Latency per sample",
    format: (v) => `${v.toFixed(2)} s`,
  },
};

/**
 * The teacher is a fixed, finished model, so its column is its reference profile. The
 * student is still training: its memory, throughput and latency are the values the last
 * published evaluation measured, identical to the metrics table and the deployment card.
 */
export function TeacherStudentRuntimeCard({
  stage,
  step,
}: {
  readonly stage: Stage;
  readonly step: number;
}) {
  const evalStep = lastEvalStep(stage, step);
  const studentValue = (key: string, planned: string): string => {
    const measured = MEASURED_STUDENT_ROWS[key];
    const spec = measured && stage.metrics.find((m) => m.label.startsWith(measured.metric));
    return measured && spec ? measured.format(metricAtEval(spec, stage, step)) : planned;
  };
  return (
    <Card
      title={stage.runtimeTitle}
      icon="runtime"
      aside={
        <span className={styles.asideNote}>
          Student measured at eval {number(evalStep)}
        </span>
      }
    >
      <div
        className={styles.tableWrap}
        tabIndex={0}
        role="region"
        aria-label={`${stage.runtimeTitle} table`}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">
                <span className="srOnly">Property</span>
              </th>
              <th scope="col" title="Teacher (Qwen3-VL-32B)">
                Teacher (32B)
              </th>
              <th scope="col" title="Student (Qwen3-VL-8B)">
                Student (8B)
              </th>
            </tr>
          </thead>
          <tbody>
            {stage.teacherStudent!.map(([key, teacher, student]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{teacher}</td>
                <td>{studentValue(key, student)}</td>
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

/**
 * The batch reward, decomposed. Values are the same rows as the reward contract (their sum is
 * the mean reward the curves plot), so the two cards cannot disagree. The live column is kept
 * apart: it is the verifier's score on the handful of carousel rollouts shown on this page,
 * a small sample that is expected to scatter around the batch figure.
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
    return { reward, value: batch[index]?.value ?? 0, live };
  });
  const total = rows.reduce((sum, row) => sum + Math.abs(row.value), 0) || 1;
  const sum = rows.reduce((acc, row) => acc + row.value, 0);
  return (
    <Card
      title="Reward breakdown"
      icon="chart"
      aside={<span className={styles.asideNote}>Batch mean {sum.toFixed(3)}</span>}
    >
      <div className={styles.tableWrap}>
        <table className={styles.table} data-reward>
          <thead>
            <tr>
              <th scope="col">Reward component</th>
              <th scope="col">Contribution</th>
              <th
                scope="col"
                title="Weight × batch score; the column sums to the batch mean reward"
              >
                Value
              </th>
              <th
                scope="col"
                title={`Verifier score on the ${liveCount} rollouts in the sample carousel (penalty: share with a fabricated tag)`}
              >
                Live ({liveCount})
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ reward, value, live }) => {
              const share = Math.abs(value) / total;
              return (
                <tr key={reward.name}>
                  <td>
                    <i
                      className={styles.dot}
                      style={{ background: reward.colour }}
                      aria-hidden="true"
                    />
                    {reward.name.replace(/ reward$/, "")}
                  </td>
                  <td>
                    <span className={styles.bar}>
                      <i
                        style={{
                          width: `${(share * 100).toFixed(1)}%`,
                          background: reward.colour,
                        }}
                      />
                    </span>
                    <small>{Math.round(share * 100)}%</small>
                  </td>
                  <td className={value < 0 ? styles.negative : undefined}>
                    {value >= 0 ? "+" : "−"}
                    {Math.abs(value).toFixed(3)}
                  </td>
                  <td>
                    {live === undefined ? (
                      "—"
                    ) : (
                      <>
                        {live.toFixed(2)}
                        <span className={styles.liveTag}>live</span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Artifacts
// ────────────────────────────────────────────────────────────────────────────────────────────

const ARTIFACT_LABELS: Record<ArtifactSpec["icon"], string> = {
  cube: "REP",
  book: "VOC",
  target: "HEAD",
  graph: "GRAPH",
  box: "CKPT",
  code: "CODE",
  table: "DATA",
  db: "DATA",
  flag: "EVAL",
  file: "FILE",
  gear: "CFG",
  shield: "EVAL",
  chart: "STAT",
  rocket: "SERVE",
};

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

/** Phases a writer walks through, in order, while an artifact is being produced. */
const WRITE_PHASES: Record<"weights" | "file", readonly string[]> = {
  weights: [
    "Gathering optimizer state",
    "Serializing tensor shards",
    "Flushing shards to object store",
    "Computing content digest",
  ],
  file: ["Rendering from run state", "Validating schema", "Computing content digest"],
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
  const hallucination = stage.metrics.find((metric) =>
    metric.label.startsWith("Hallucination rate"),
  );

  // Rolling checkpoint writes: where the current shard write is, and when the next one lands.
  const lastCheckpoint = Math.floor(step / run.checkpointEvery) * run.checkpointEvery;
  const toNext = Math.min(run.totalSteps, lastCheckpoint + run.checkpointEvery) - step;
  const cycleShare = 1 - toNext / run.checkpointEvery;

  return (
    <Card
      title={stage.outputsTitle}
      icon="file"
      className={styles.outputs}
      aside={
        <span className={styles.outputsAside}>
          <span className={styles.asideNote}>
            {emittedCount} of {stage.outputs.length} emitted
          </span>
          <span
            className={styles.inlineStatus}
            data-state={allReady ? "run" : running ? "sim" : "pause"}
          >
            <i aria-hidden="true" />
            {allReady
              ? stage.id === "distillation"
                ? "Ready for deployment"
                : "All artifacts emitted"
              : running
                ? "Emitting on schedule"
                : "Emission paused"}
          </span>
        </span>
      }
    >
      <ul className={styles.artifacts}>
        {stage.outputs.map((spec) => {
          const readyStep = spec.readyAt * run.totalSteps;
          const window = Math.max(1, WRITE_SECONDS * run.stepsPerSecond);
          const secondsSince = (step - readyStep) / run.stepsPerSecond;
          let state: ArtifactState;
          if (spec.readyAt === 0) state = "tracking";
          else if (step >= readyStep) state = secondsSince > 90 ? "verified" : "emitted";
          else if (readyStep - step <= window) state = "writing";
          else state = "queued";

          let subtitle = spec.subtitle;
          let detail = spec.detail;
          if (spec.subtitle === "experiment") {
            subtitle = `Ready for SFT · ${stage.experimentId}`;
          }
          if (spec.subtitle === "hallucination" && hallucination) {
            // The value the metrics table shows: the last published evaluation.
            const value = metricAtEval(hallucination, stage, step);
            subtitle = `${Math.round(hallucination.start * 100)}% → ${(value * 100).toFixed(1)}%`;
            detail = `↓ ${((1 - value / hallucination.start) * 100).toFixed(1)}% relative reduction`;
          }
          if (spec.id === "candidate") {
            detail =
              step >= readyStep ? "✓ Ready for Stage 4" : "Released at 100% of the run";
          }

          const weights = spec.download === "weights";
          const phases = WRITE_PHASES[weights ? "weights" : "file"];
          const writeShare = state === "writing" ? 1 - (readyStep - step) / window : 0;
          const phase =
            phases[Math.min(phases.length - 1, Math.floor(writeShare * phases.length))]!;
          const hash = digest(stage, spec, Math.round(readyStep));
          const fresh = (state === "emitted" || state === "verified") && secondsSince < 600;

          let meta: ReactNode;
          switch (state) {
            case "queued":
              meta = (
                <>
                  <span>
                    Due at step {number(Math.round(readyStep))} · in{" "}
                    {formatDuration((readyStep - step) / run.stepsPerSecond)}
                    {running ? "" : " (paused)"}
                  </span>
                  {weights && lastCheckpoint > 0 && (
                    <span>
                      Rolling checkpoint {formatSteps(lastCheckpoint)} · next in{" "}
                      {formatDuration(toNext / run.stepsPerSecond)}
                    </span>
                  )}
                </>
              );
              break;
            case "writing":
              meta = (
                <>
                  <span className={styles.writing}>
                    {phase}
                    {weights ? ` · shard ${Math.max(1, Math.ceil(writeShare * 8))}/8` : ""}
                  </span>
                  <span className={styles.writeBar} data-running={running || undefined}>
                    <i style={{ width: `${(writeShare * 100).toFixed(1)}%` }} />
                  </span>
                </>
              );
              break;
            case "emitted":
            case "verified":
              meta = (
                <>
                  <span>
                    {state === "verified" ? "Verified" : "Emitted"}{" "}
                    {formatAgo(secondsSince)} · {clockTime(now - secondsSince * 1000)} ·
                    step {number(Math.round(readyStep))}
                  </span>
                  <span
                    className={styles.digest}
                    title="Content digest of the simulated artifact record. No weights exist behind it."
                  >
                    sha256:{hash.slice(0, 8)}…{hash.slice(-4)}
                  </span>
                </>
              );
              break;
            case "tracking":
              meta = (
                <span>Live from policy evaluation · step {number(Math.floor(step))}</span>
              );
              break;
          }

          return (
            <li
              key={spec.id}
              data-ready={
                state === "emitted" ||
                state === "verified" ||
                state === "tracking" ||
                undefined
              }
              data-state={state}
              data-fresh={fresh || undefined}
            >
              <div className={styles.artifactTop}>
                <span className={styles.technicalLabel} aria-hidden="true">
                  {ARTIFACT_LABELS[spec.icon]}
                </span>
                <span className={styles.artifactText}>
                  <strong>{spec.title}</strong>
                  <small>{subtitle}</small>
                  <small
                    className={
                      spec.id === "candidate" && step >= readyStep ? styles.up : undefined
                    }
                  >
                    {detail}
                  </small>
                </span>
                {state === "queued" ? (
                  <Ring
                    share={step / readyStep}
                    label={`${spec.title}: ${Math.floor((step / readyStep) * 100)} percent of the way to emission`}
                  />
                ) : spec.download && !weights ? (
                  <button
                    className={styles.downloadButton}
                    disabled={state === "writing"}
                    onClick={() => download(spec)}
                    title={
                      state === "writing" ? "Being written" : "Download the generated file"
                    }
                    aria-label={`Download ${spec.title}`}
                  >
                    <Icon name="download" size={16} />
                  </button>
                ) : weights ? (
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
              </div>
              <div className={styles.artifactFoot}>
                <span className={styles.stateChip} data-state={state}>
                  <i aria-hidden="true" />
                  {STATE_LABEL[state]}
                </span>
                <span className={styles.artifactMeta}>{meta}</span>
              </div>
              {weights && state !== "writing" && (
                <span
                  className={styles.cycleBar}
                  data-running={running || undefined}
                  title={`Checkpoint write cycle: ${Math.floor(cycleShare * 100)}% to step ${number(lastCheckpoint + run.checkpointEvery)}`}
                  aria-hidden="true"
                >
                  <i style={{ width: `${(cycleShare * 100).toFixed(1)}%` }} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
