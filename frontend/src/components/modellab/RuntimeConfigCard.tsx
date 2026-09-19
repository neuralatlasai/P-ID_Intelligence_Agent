"use client";

import { useId, useMemo, type ReactNode } from "react";

import {
  ACCELERATORS,
  BACKBONES,
  GRAPH_ENCODERS,
  GROUP_SIZE,
  MFU,
  runProfile,
  SPATIAL_ENCODERS,
  type Precision,
  type RunConfig,
  type RunProfile,
  type Trainable,
} from "@/lib/modellab/config";
import {
  configChanges,
  draftStepsPerSecond,
  etaSeconds,
  formatEta,
} from "@/lib/modellab/hardware";

import { Card } from "./Cards";
import { accumulation } from "./flow/stepFlow";
import type { LiveCardProps } from "./live";
import styles from "./RuntimeConfigCard.module.css";

export type RuntimeConfigCardProps = LiveCardProps & {
  readonly draft: RunConfig;
  readonly onDraft: (next: RunConfig) => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly statusChip: ReactNode;
};

const NODE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const GPU_OPTIONS = [4, 8] as const;
const BATCH_OPTIONS = [32, 64, 128, 256, 512, 1024] as const;

const params = (billions: number) =>
  billions >= 1
    ? `${billions.toFixed(billions >= 10 ? 0 : 1)}B`
    : `${(billions * 1000).toFixed(0)}M`;

function backboneLabel(backbone: (typeof BACKBONES)[number]): string {
  const size =
    backbone.active < backbone.params
      ? `${params(backbone.params)} (${params(backbone.active)} active)`
      : params(backbone.params);
  return `${backbone.name} · ${size} · ${backbone.contextK}K ctx`;
}

function encoderLabel(encoder: { name: string; paramsM: number }): string {
  return encoder.paramsM > 0
    ? `${encoder.name} · ${params(encoder.paramsM / 1000)}`
    : encoder.name;
}

/** A labelled select; the visible label is the accessible name. */
function Control({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={`${styles.control} ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

// ── parameter bar ──────────────────────────────────────────────────────────────────────────

/** Total parameters split by what trains: frozen hatched, trainable solid (the figure grammar). */
function ParamBar({ profile }: { readonly profile: RunProfile }) {
  // A url(#…) fragment must be a plain name; useId may contain colons.
  const hatch = `hatch-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const backbone = profile.backbone.params;
  const encoders = (profile.spatial.paramsM + profile.graph.paramsM) / 1000;
  const total = backbone + encoders;
  const trainable = Math.min(total, profile.trainableB);
  const share = (value: number) => `${(value / Math.max(1e-9, total)) * 100}%`;
  return (
    <div
      className={styles.paramBar}
      role="img"
      aria-label={`Parameters: ${params(total)} total (${params(backbone)} language backbone, ${params(encoders)} encoders), ${params(trainable)} trainable, the rest frozen.`}
    >
      <svg aria-hidden="true" className={styles.patterns}>
        <defs>
          <pattern
            id={hatch}
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="5" className={styles.hatchLine} />
          </pattern>
        </defs>
      </svg>
      <span className={styles.paramTrack} aria-hidden="true">
        <span className={styles.frozen} style={{ width: share(total - trainable) }}>
          <svg>
            <rect width="100%" height="100%" fill={`url(#${hatch})`} />
          </svg>
        </span>
        <span className={styles.trainable} style={{ width: share(trainable) }} />
        <i className={styles.encoderSplit} style={{ left: share(backbone) }} />
      </span>
      <span className={styles.paramScale} aria-hidden="true">
        <code>{params(total)}</code>
        <code>
          <b>{params(trainable)}</b> train
        </code>
      </span>
    </div>
  );
}

// ── batch geometry ─────────────────────────────────────────────────────────────────────────

const MAX_ROWS = 16;
const MAX_COLS = 64;

/**
 * Global batch as a rank × accumulation lattice: one column per data-parallel rank, grouped
 * by node; one row per micro-batch accumulated before the optimizer step; each cell is one
 * micro-batch of `micro` sequences. B = ranks × micro × accumulation.
 */
function BatchGeometry({
  config,
  stageId,
}: {
  readonly config: RunConfig;
  readonly stageId: LiveCardProps["stage"]["id"];
}) {
  const nodes = Math.max(1, config.nodes);
  const perNode = Math.max(1, config.gpusPerNode);
  const ranks = nodes * perNode;
  const accum = accumulation(config, ranks);
  const micro = Math.max(1, config.globalBatch / ranks / accum);
  const rows = Math.min(MAX_ROWS, accum);
  const cols = Math.min(MAX_COLS, ranks);
  const cell = 7;
  const gap = 1.5;
  const nodeGap = 5;
  const width =
    cols * cell + (cols - 1) * gap + Math.max(0, Math.ceil(cols / perNode) - 1) * nodeGap;
  const height = rows * cell + (rows - 1) * gap;
  const x = (rank: number) => rank * (cell + gap) + Math.floor(rank / perNode) * nodeGap;
  const rolloutFanout = stageId === "rl" ? GROUP_SIZE : 1;
  const exact = Number.isInteger(micro);
  return (
    <figure className={styles.geometry}>
      <div className={styles.lattice}>
        <span className={styles.yAxis} aria-hidden="true">
          accum {accum}
          {accum > MAX_ROWS ? ` (${MAX_ROWS} shown)` : ""}
        </span>
        <svg
          viewBox={`-1 -1 ${width + 2} ${height + 2}`}
          role="img"
          aria-label={`Global batch ${config.globalBatch}${rolloutFanout > 1 ? ` prompts, each sampled ${rolloutFanout} times,` : ""} = ${ranks} data-parallel ranks (${nodes} nodes × ${perNode} GPUs) × micro-batch ${exact ? micro : micro.toFixed(2)} × ${accum} accumulation steps.`}
          style={{ maxWidth: `${Math.max(120, (width + 2) * 3.2)}px` }}
        >
          {Array.from({ length: Math.ceil(cols / perNode) }, (_, n) => (
            <rect
              key={`n${n}`}
              className={styles.nodeBand}
              x={x(n * perNode) - 1}
              y={-1}
              width={Math.min(perNode, cols - n * perNode) * (cell + gap) - gap + 2}
              height={height + 2}
            />
          ))}
          {Array.from({ length: rows }, (_, r) =>
            Array.from({ length: cols }, (_, c) => (
              <rect
                key={`${r}:${c}`}
                className={styles.micro}
                data-last={r === rows - 1 || undefined}
                x={x(c)}
                y={r * (cell + gap)}
                width={cell}
                height={cell}
              />
            )),
          )}
        </svg>
      </div>
      <figcaption className={styles.equation} aria-hidden="true">
        <b>{config.globalBatch}</b>
        {rolloutFanout > 1 ? <small>×{rolloutFanout}</small> : null}
        <span>=</span>
        <b>{ranks}</b>
        <small>DP</small>
        <span>×</span>
        <b>{exact ? micro : micro.toFixed(2)}</b>
        <small>micro</small>
        <span>×</span>
        <b>{accum}</b>
        <small>accum</small>
      </figcaption>
    </figure>
  );
}

// ── draft delta ────────────────────────────────────────────────────────────────────────────

/** Applied → draft for one figure, as two bars on a shared scale. */
function Delta({
  label,
  before,
  after,
  format,
  limit,
  worseWhenHigher = true,
}: {
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly format: (value: number) => string;
  /** A hard ceiling drawn on the scale (memory capacity). */
  readonly limit?: number;
  readonly worseWhenHigher?: boolean;
}) {
  const finite = [before, after, limit ?? 0].filter(Number.isFinite);
  const scale = Math.max(1e-9, ...finite);
  const width = (value: number) =>
    `${Number.isFinite(value) ? Math.min(100, (value / scale) * 100) : 100}%`;
  const direction =
    after === before ? "same" : after > before === worseWhenHigher ? "worse" : "better";
  return (
    <div className={styles.delta} data-direction={direction}>
      <span className={styles.deltaLabel}>{label}</span>
      <span className={styles.deltaBars} aria-hidden="true">
        <i data-series="applied" style={{ width: width(before) }} />
        <i data-series="draft" style={{ width: width(after) }} />
        {limit !== undefined ? (
          <b className={styles.deltaLimit} style={{ left: width(limit) }} />
        ) : null}
      </span>
      <span className={styles.deltaValue}>
        {format(before)} → <b>{format(after)}</b>
      </span>
    </div>
  );
}

export function RuntimeConfigCard({
  stage,
  step,
  config,
  profile,
  draft,
  onDraft,
  onApply,
  onDiscard,
  statusChip,
}: RuntimeConfigCardProps) {
  const fitId = useId();
  const pendingId = useId();
  const draftProfile = useMemo(() => runProfile(stage.id, draft), [stage.id, draft]);
  const changes = configChanges(config, draft);
  const pending = changes.length > 0;

  const draftSteps = draftStepsPerSecond(stage.run.stepsPerSecond, profile, draftProfile);
  const total = stage.run.totalSteps;
  const currentEta = etaSeconds(total, step, stage.run.stepsPerSecond);
  const draftEta = etaSeconds(total, step, draftSteps);
  const gpuHoursPerK = (rate: number, gpus: number) =>
    rate > 0 ? (gpus * 1000) / rate / 3600 : Number.POSITIVE_INFINITY;

  const set = <K extends keyof RunConfig>(key: K, value: RunConfig[K]) =>
    onDraft({ ...draft, [key]: value });

  return (
    <Card
      title={stage.teacherStudent ? "Student training runtime" : stage.runtimeTitle}
      icon="runtime"
      aside={statusChip}
    >
      <div className={styles.body}>
        <div className={styles.figHead}>
          <span className={styles.fig}>FIGURE 04G · RUN GEOMETRY</span>
          <span className={styles.mfu}>MFU {Math.round(MFU * 100)}%</span>
          <span className="srOnly">
            Planning estimate: about 6·N FLOPs per token for a full fine-tune and 4·N with a
            frozen backbone, N the active parameters including encoders; throughput is GPUs
            × accelerator FLOP/s × MFU {Math.round(MFU * 100)}% over FLOPs per token. Memory
            is 16 bytes per trainable parameter sharded across ranks, plus frozen weights
            and activations.
          </span>
        </div>

        <section className={styles.group} aria-label="Model stack">
          <span className={styles.groupTag} aria-hidden="true">
            θ
          </span>
          <div className={styles.controls} data-columns="3">
            <Control label="Vision-language model">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.backbone}
                  onChange={(event) => set("backbone", event.target.value)}
                >
                  {BACKBONES.map((backbone) => (
                    <option key={backbone.id} value={backbone.id}>
                      {backboneLabel(backbone)}
                    </option>
                  ))}
                </select>
              )}
            </Control>
            <Control label="3D spatial encoder">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.spatial}
                  onChange={(event) => set("spatial", event.target.value)}
                >
                  {SPATIAL_ENCODERS.map((encoder) => (
                    <option key={encoder.id} value={encoder.id}>
                      {encoderLabel(encoder)}
                    </option>
                  ))}
                </select>
              )}
            </Control>
            <Control label="Graph encoder">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.graph}
                  onChange={(event) => set("graph", event.target.value)}
                >
                  {GRAPH_ENCODERS.map((encoder) => (
                    <option key={encoder.id} value={encoder.id}>
                      {encoderLabel(encoder)}
                    </option>
                  ))}
                </select>
              )}
            </Control>
          </div>
          <div className={styles.controls} data-columns="2">
            <Control label="Trainable">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.trainable}
                  onChange={(event) => set("trainable", event.target.value as Trainable)}
                >
                  <option value="lora">LoRA + projector</option>
                  <option value="full">Full fine-tune</option>
                </select>
              )}
            </Control>
            <Control label="Precision">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.precision}
                  onChange={(event) => set("precision", event.target.value as Precision)}
                >
                  <option value="bf16">BF16 mixed precision</option>
                  <option value="fp8">FP8 (Transformer Engine)</option>
                </select>
              )}
            </Control>
          </div>
          <ParamBar profile={draftProfile} />
        </section>

        <section className={styles.group} aria-label="Parallel geometry">
          <span className={styles.groupTag} aria-hidden="true">
            B
          </span>
          <div className={styles.controls} data-columns="4">
            <Control label="Accelerator">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.accelerator}
                  onChange={(event) => set("accelerator", event.target.value)}
                >
                  {ACCELERATORS.map((accelerator) => (
                    <option key={accelerator.id} value={accelerator.id}>
                      {accelerator.name}
                    </option>
                  ))}
                </select>
              )}
            </Control>
            <Control label="Nodes">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.nodes}
                  onChange={(event) => set("nodes", Number(event.target.value))}
                >
                  {NODE_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              )}
            </Control>
            <Control label="GPUs per node">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.gpusPerNode}
                  onChange={(event) => set("gpusPerNode", Number(event.target.value))}
                >
                  {GPU_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              )}
            </Control>
            <Control label="Global batch">
              {(id) => (
                <select
                  id={id}
                  className={styles.select}
                  value={draft.globalBatch}
                  onChange={(event) => set("globalBatch", Number(event.target.value))}
                >
                  {BATCH_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              )}
            </Control>
          </div>
          <BatchGeometry config={draft} stageId={stage.id} />
        </section>

        {!draftProfile.fits ? (
          <p className={styles.fitWarning} id={fitId}>
            <i aria-hidden="true" />
            Does not fit · {draftProfile.memoryPerGpuGb.toFixed(0)} /{" "}
            {draftProfile.accelerator.memoryGb} GB
          </p>
        ) : null}

        {pending ? (
          <div className={styles.pending} role="region" aria-labelledby={pendingId}>
            <p id={pendingId} className={styles.pendingText} aria-live="polite">
              <strong>
                {changes.length} {changes.length === 1 ? "change" : "changes"}
              </strong>
              <span className="srOnly">
                {" "}
                · ETA {formatEta(currentEta)} → {formatEta(draftEta)}
              </span>
            </p>
            <div className={styles.deltas}>
              <Delta
                label="step"
                before={1 / Math.max(1e-9, stage.run.stepsPerSecond)}
                after={draftSteps > 0 ? 1 / draftSteps : Number.POSITIVE_INFINITY}
                format={(value) =>
                  Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} s` : "—"
                }
              />
              <Delta label="ETA" before={currentEta} after={draftEta} format={formatEta} />
              <Delta
                label="HBM"
                before={profile.memoryPerGpuGb}
                after={draftProfile.memoryPerGpuGb}
                limit={draftProfile.accelerator.memoryGb * 0.92}
                format={(value) => `${value.toFixed(0)} GB`}
              />
              <Delta
                label="GPU·h/1K"
                before={gpuHoursPerK(stage.run.stepsPerSecond, profile.gpus)}
                after={gpuHoursPerK(draftSteps, draftProfile.gpus)}
                format={(value) =>
                  Number.isFinite(value) ? value.toFixed(value >= 100 ? 0 : 1) : "—"
                }
              />
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.apply}
                onClick={onApply}
                disabled={!draftProfile.fits}
                aria-describedby={draftProfile.fits ? undefined : fitId}
              >
                Apply &amp; restart from last checkpoint
              </button>
              <button type="button" className={styles.discard} onClick={onDiscard}>
                Discard
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
