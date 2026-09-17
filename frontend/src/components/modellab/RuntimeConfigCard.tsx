"use client";

import { useId, useMemo, type ReactNode } from "react";

import {
  ACCELERATORS,
  BACKBONES,
  GRAPH_ENCODERS,
  MFU,
  runProfile,
  SPATIAL_ENCODERS,
  type Precision,
  type RunConfig,
  type Trainable,
} from "@/lib/modellab/config";
import {
  configChanges,
  draftStepsPerSecond,
  etaSeconds,
  formatEta,
  formatRate,
  gpuTelemetry,
} from "@/lib/modellab/hardware";

import { Card } from "./Cards";
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

function Field({
  label,
  children,
  hint,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
  readonly hint?: string;
}) {
  const id = useId();
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.value}>
        {children(id)}
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
    </div>
  );
}

function Readout({
  label,
  children,
  tag,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly tag?: "live" | "estimate";
}) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>
        <span className={styles.figure}>{children}</span>
        {tag ? (
          <span className={styles.tag} data-tag={tag}>
            {tag}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

export function RuntimeConfigCard({
  stage,
  step,
  now,
  running,
  config,
  profile,
  draft,
  onDraft,
  onApply,
  onDiscard,
  statusChip,
}: RuntimeConfigCardProps) {
  const tipId = useId();
  const fitId = useId();
  const pendingId = useId();
  const draftProfile = useMemo(() => runProfile(stage.id, draft), [stage.id, draft]);
  const changes = configChanges(config, draft);
  const pending = changes.length > 0;

  const telemetry = gpuTelemetry(profile, config, stage.run.stepsPerSecond, running, now);
  const liveThroughput = running && !pending;

  const draftSteps = draftStepsPerSecond(stage.run.stepsPerSecond, profile, draftProfile);
  const total = stage.run.totalSteps;
  const currentEta = etaSeconds(total, step, stage.run.stepsPerSecond);
  const draftEta = etaSeconds(total, step, draftSteps);
  const gpus = draftProfile.gpus;
  const gpuHoursPerK = draftSteps > 0 ? (gpus * 1000) / draftSteps / 3600 : 0;

  const capacity = draftProfile.accelerator.memoryGb;
  const memShare = Math.min(1, draftProfile.memoryPerGpuGb / capacity);
  const fitState = !draftProfile.fits ? "over" : memShare > 0.8 ? "tight" : "ok";

  const set = <K extends keyof RunConfig>(key: K, value: RunConfig[K]) =>
    onDraft({ ...draft, [key]: value });

  const samples = liveThroughput
    ? telemetry.samplesPerSecond
    : draftProfile.samplesPerSecond;
  const tokens = liveThroughput ? telemetry.tokensPerSecond : draftProfile.tokensPerSecond;
  const stepTime = liveThroughput
    ? telemetry.stepsPerSecond > 0
      ? 1 / telemetry.stepsPerSecond
      : 0
    : draftSteps > 0
      ? 1 / draftSteps
      : 0;

  return (
    <Card title={stage.runtimeTitle} icon="runtime" aside={statusChip}>
      <div className={styles.body}>
        <div className={styles.grid} role="group" aria-label="Model stack and cluster">
          <Field label="Vision-language model">
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
          </Field>
          <Field label="3D spatial encoder">
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
          </Field>
          <Field label="Graph encoder">
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
          </Field>
          <Field label="Accelerator">
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
          </Field>
          <div className={styles.row}>
            <span className={styles.label} id={`${pendingId}-cluster`}>
              Nodes × GPUs
            </span>
            <div className={styles.value}>
              <div
                className={styles.pair}
                role="group"
                aria-labelledby={`${pendingId}-cluster`}
              >
                <select
                  className={styles.select}
                  aria-label="Nodes"
                  value={draft.nodes}
                  onChange={(event) => set("nodes", Number(event.target.value))}
                >
                  {NODE_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count} {count === 1 ? "node" : "nodes"}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.select}
                  aria-label="GPUs per node"
                  value={draft.gpusPerNode}
                  onChange={(event) => set("gpusPerNode", Number(event.target.value))}
                >
                  {GPU_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count} GPU/node
                    </option>
                  ))}
                </select>
              </div>
              <span className={styles.hint}>{gpus} GPUs total</span>
            </div>
          </div>
          <Field label="Precision">
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
          </Field>
          <Field label="Trainable">
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
          </Field>
          <Field label="Global batch">
            {(id) => (
              <select
                id={id}
                className={styles.select}
                value={draft.globalBatch}
                onChange={(event) => set("globalBatch", Number(event.target.value))}
              >
                {BATCH_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} samples
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <div className={styles.estimateHead}>
          <span className={styles.estimateLabel}>
            Planning estimate · MFU {Math.round(MFU * 100)} %
          </span>
          <span className={styles.tipWrap}>
            <button
              type="button"
              className={styles.tipButton}
              aria-label="How the estimate is computed"
              aria-describedby={tipId}
            >
              <span aria-hidden="true">i</span>
            </button>
            <span role="tooltip" id={tipId} className={styles.tip}>
              Compute per token is about 6·N FLOPs for a full fine-tune and 4·N when the
              backbone is frozen (N = active parameters incl. encoders). Throughput = GPUs ×
              accelerator FLOPs/s × MFU {Math.round(MFU * 100)} % ÷ FLOPs per token. Memory:
              16 bytes per trainable parameter sharded by ZeRO-3, plus frozen weights and
              activations.
            </span>
          </span>
        </div>

        <dl className={styles.grid}>
          <Readout label="Trainable params">
            {params(draftProfile.trainableB)}
            <span className={styles.sub}>
              {" "}
              of{" "}
              {params(
                draftProfile.backbone.params +
                  (draftProfile.spatial.paramsM + draftProfile.graph.paramsM) / 1000,
              )}
            </span>
          </Readout>
          <Readout label="Throughput" tag={liveThroughput ? "live" : "estimate"}>
            {formatRate(samples)} samples/s
          </Readout>
          <Readout label="Tokens/s" tag={liveThroughput ? "live" : "estimate"}>
            {formatRate(tokens)}
          </Readout>
          <Readout label="Step time">
            {stepTime > 0 ? `${stepTime.toFixed(stepTime >= 10 ? 1 : 2)} s` : "—"}
          </Readout>
          <div className={styles.row}>
            <dt className={styles.label}>Memory per GPU</dt>
            <dd className={styles.value}>
              <span className={styles.figure} data-fit={fitState}>
                {draftProfile.memoryPerGpuGb.toFixed(1)} / {capacity} GB
              </span>
              <span
                className={styles.fitBar}
                data-fit={fitState}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={capacity}
                aria-valuenow={Math.round(Math.min(capacity, draftProfile.memoryPerGpuGb))}
                aria-label="Memory per GPU"
                aria-describedby={draftProfile.fits ? undefined : fitId}
              >
                <i style={{ width: `${(memShare * 100).toFixed(1)}%` }} />
              </span>
              {!draftProfile.fits ? (
                <span className={styles.fitWarning} id={fitId}>
                  Does not fit — reduce batch, add GPUs or use FP8/LoRA
                </span>
              ) : null}
            </dd>
          </div>
          <Readout label="GPU-hours / 1K steps">
            {gpuHoursPerK >= 100 ? gpuHoursPerK.toFixed(0) : gpuHoursPerK.toFixed(1)}
          </Readout>
          <Readout label="ETA (remaining)">
            {formatEta(draftEta)}
            <span className={styles.sub}>
              {" "}
              · {Math.max(0, Math.round(total - step)).toLocaleString("en-US")} steps
            </span>
          </Readout>
          <Readout label="Experiment ID">
            <code className={styles.code}>{stage.experimentId}</code>
          </Readout>
          <Readout label="Global step">{Math.floor(step).toLocaleString("en-US")}</Readout>
        </dl>

        {pending ? (
          <div className={styles.pending} role="region" aria-labelledby={pendingId}>
            <p id={pendingId} className={styles.pendingText} aria-live="polite">
              <strong>
                {changes.length} {changes.length === 1 ? "change" : "changes"}
              </strong>{" "}
              · ETA {formatEta(currentEta)} → {formatEta(draftEta)}
            </p>
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
