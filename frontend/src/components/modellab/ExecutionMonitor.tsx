"use client";

import { useMemo, useState } from "react";

import {
  buildSyntheticCandidates,
  EXECUTION_RECIPES,
  executionSnapshot,
  METHOD_SOURCES,
  type DiagnosticScenario,
} from "@/lib/modellab/execution";
import type { LabSample } from "@/lib/modellab/samples";

import type { LiveCardProps } from "./live";
import css from "./ExecutionMonitor.module.css";

const SCENARIOS = [
  ["nominal", "Nominal execution"],
  ["input-stall", "Input starvation"],
  ["quality-regression", "Quality regression"],
] as const;

/** Shares the run clock; inspection and scenario state never mutate the underlying run. */
export function ExecutionMonitor({
  stage,
  step,
  running,
  config,
  profile,
  samples,
  sourceId,
  blocked,
}: LiveCardProps & {
  readonly samples: readonly LabSample[];
  readonly sourceId: string;
  readonly blocked: boolean;
}) {
  const [scenario, setScenario] = useState<DiagnosticScenario>("nominal");
  const [inspected, setInspected] = useState<number | undefined>();
  const [pinnedBatch, setPinnedBatch] = useState<number | undefined>();
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<"diagnostics" | "synthetic" | "evaluation">("diagnostics");
  const recipe = EXECUTION_RECIPES[stage.id];
  // The same telemetry the run console reads, so the two panels agree step for step.
  const context = useMemo(() => ({ stage, profile, config }), [stage, profile, config]);
  const snapshot = executionSnapshot(stage, blocked ? 0 : step, scenario, context);
  const batch = pinnedBatch ?? Math.floor(snapshot.tick / 18);
  const active = inspected ?? snapshot.phase;
  const phase = recipe.phases[active]!;
  const candidates = useMemo(
    () => buildSyntheticCandidates(samples, sourceId, batch),
    [samples, sourceId, batch],
  );
  const candidate = candidates[selected] ?? candidates[0];
  const review = candidates.filter((item) => item.decision === "review").length;
  const complete = step >= stage.run.totalSteps;
  const status = blocked
    ? "Blocked by lineage"
    : complete
      ? "Run complete"
      : running
        ? "Replay advancing"
        : "Replay paused";
  // Scaled to at least 10 %, so a healthy few-percent wait is visible and a stall is a spike.
  const traceMax = Math.max(10, ...snapshot.trace);
  const points = snapshot.trace
    .map((value, index) => `${index * 10},${65 - (value / traceMax) * 60}`)
    .join(" ");

  return (
    <section
      className={css.root}
      aria-label="Stage execution monitor"
      data-tick={snapshot.tick}
      data-running={running}
    >
      <header className={css.header}>
        <div>
          <span className={css.eyebrow}>EXECUTION / {stage.id.toUpperCase()}</span>
          <h2>{recipe.objective}</h2>
          <p>
            Workflow replay · training telemetry simulated · local record checks executed
          </p>
        </div>
        <div className={css.status} role="status">
          <i aria-hidden="true" />
          {status}
          <small>STEP {Math.floor(step).toLocaleString("en-US")}</small>
        </div>
      </header>

      <div className={css.context}>
        <span>{profile.backbone.name}</span>
        <span>
          {profile.gpus} × {profile.accelerator.name}
        </span>
        <span>
          {config.precision.toUpperCase()} ·{" "}
          {config.trainable === "full" ? "Full parameter" : "LoRA"}
        </span>
        <span>Global batch {config.globalBatch}</span>
        <span>Worker connection: unattached</span>
      </div>

      <ol className={css.flow} aria-label="Execution phases">
        {recipe.phases.map((item, index) => (
          <li
            key={item.name}
            data-active={index === snapshot.phase}
            data-inspected={index === active}
          >
            <button
              type="button"
              aria-pressed={index === active}
              onClick={() => setInspected(index)}
            >
              <span className={css.phaseIndex}>
                {String(index + 1).padStart(2, "0")}
                <small>
                  {index === snapshot.phase
                    ? running
                      ? "ACTIVE"
                      : "HELD"
                    : index < snapshot.phase
                      ? "TRAVERSED"
                      : "QUEUED"}
                </small>
              </span>
              <strong>{item.name}</strong>
              <span className={css.track}>
                <span
                  style={{
                    width: `${index < snapshot.phase ? 100 : index === snapshot.phase ? snapshot.phaseProgress * 100 : 0}%`,
                  }}
                />
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className={css.inspector}>
        <div>
          <span className={css.eyebrow}>
            {inspected === undefined ? "FOLLOWING EXECUTION" : "PHASE INSPECTION"}
          </span>
          <h3>{phase.name}</h3>
          <p>{phase.operation}</p>
        </div>
        <div>
          <span className={css.eyebrow}>OUTPUT CONTRACT</span>
          <p>{phase.output}</p>
          <button
            type="button"
            disabled={inspected === undefined}
            onClick={() => setInspected(undefined)}
          >
            Follow execution
          </button>
        </div>
      </div>

      <div className={css.toolbar}>
        <div className={css.tabs} role="group" aria-label="Execution analysis">
          {(
            [
              ["diagnostics", "Training diagnostics"],
              ["synthetic", "Synthetic data QC"],
              ["evaluation", "Evaluation gates"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          Diagnostic scenario
          <select
            value={scenario}
            onChange={(event) => setScenario(event.target.value as DiagnosticScenario)}
          >
            {SCENARIOS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {tab === "diagnostics" && (
        <div className={css.diagnostics}>
          <div className={css.metrics}>
            <div>
              <span>{recipe.diagnostics[0]}</span>
              <strong>
                {snapshot.wait.toFixed(1)}
                <small>%</small>
              </strong>
              <svg
                viewBox="0 0 230 70"
                role="img"
                aria-label={`Share of each step spent waiting, last 24 steps, scale 0–${traceMax.toFixed(0)} %`}
              >
                <path d="M0 65H230 M0 35H230 M0 5H230" className={css.grid} />
                <polyline points={points} />
              </svg>
            </div>
            <div>
              <span>{recipe.diagnostics[1]}</span>
              <strong>
                {snapshot.secondary.toFixed(1)}
                <small>%</small>
              </strong>
              <p>
                {stage.id === "rl"
                  ? "Prompt groups with no reward variation"
                  : "Illustrative batch composition"}
              </p>
            </div>
            <div>
              <span>{recipe.diagnostics[2]}</span>
              <strong>{snapshot.tertiary.toFixed(3)}</strong>
              <p>
                {stage.id === "rl"
                  ? "Tokens affected by policy clipping"
                  : "Global L2 norm before clipping"}
              </p>
            </div>
            <div>
              <span>Learning rate</span>
              <strong>{snapshot.learningRate.toExponential(2)}</strong>
              <p>Configured warmup → cosine decay</p>
            </div>
          </div>
          <div className={css.diagnosticNote} data-alert={scenario !== "nominal"}>
            <strong>
              {scenario === "input-stall"
                ? "Input starvation · update dispatch waiting"
                : scenario === "quality-regression"
                  ? stage.id === "rl"
                    ? "Reward collapse · inspect zero-variance groups"
                    : "Gradient excursion · inspect data and loss scaling"
                  : "Optimizer trace · nominal scenario"}
            </strong>
            <p>
              {scenario === "input-stall"
                ? "The replay holds at input dispatch. Inspect shard availability, preprocessing latency and prefetch depth before increasing worker count."
                : scenario === "quality-regression"
                  ? "This injected diagnostic affects this panel only. Compare the failed slice and verifier outputs before accepting an update; the recorded evaluation gates remain unchanged."
                  : `Proposed execution: ${config.trainable === "full" ? "parameter, gradient and optimizer-state sharding" : "frozen backbone with trainable adapters"}; activation checkpointing and gradient accumulation. Kernel support and memory must be measured on the selected device.`}
            </p>
            <small>
              Scenario diagnostics are illustrative; they do not change the run
              configuration or claim a worker failure.
            </small>
          </div>
        </div>
      )}

      {tab === "synthetic" && (
        <div className={css.synthetic} data-batch={batch}>
          <div className={css.batchHeader}>
            <div>
              <h3>Source-grounded candidate batch</h3>
              <p>
                Template generation · {candidates.length} candidates · {review} awaiting
                review · {candidates.length - review} rejected · 0 admitted
              </p>
              <p>
                {pinnedBatch === undefined
                  ? "Following replay batches · 18-second cadence"
                  : "Batch pinned for inspection"}
              </p>
            </div>
            <div className={css.batchActions}>
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
          <p className={css.note}>
            Local templates include deliberate duplicate and invalid-reference controls.
            Passing these checks does not establish semantic quality. Admission requires
            source-group split assignment and independent review.
          </p>
          {candidate ? (
            <div className={css.candidateLayout}>
              <div
                className={css.candidates}
                role="group"
                aria-label="Synthetic candidates"
              >
                {candidates.map((item, index) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={candidate.id === item.id}
                    onClick={() => {
                      setPinnedBatch(batch);
                      setSelected(index);
                    }}
                  >
                    <code>{item.id}</code>
                    <span data-decision={item.decision}>
                      {item.decision === "review"
                        ? "Awaiting review"
                        : item.decision === "duplicate"
                          ? "Exact duplicate"
                          : "Invalid reference"}
                    </span>
                  </button>
                ))}
              </div>
              <div className={css.record}>
                <span className={css.eyebrow}>RECORD / {candidate.generator}</span>
                <dl>
                  <dt>Source</dt>
                  <dd>
                    {candidate.sourceId} · {candidate.nodeId}
                  </dd>
                  <dt>Instruction</dt>
                  <dd>{candidate.prompt}</dd>
                  <dt>Candidate target</dt>
                  <dd>{candidate.response}</dd>
                  <dt>QC decision</dt>
                  <dd>
                    {candidate.decision === "review"
                      ? "Entity reference resolved. Quarantined pending source split and target review."
                      : candidate.decision === "duplicate"
                        ? "Rejected: identical source, instruction and response already occur in this batch."
                        : "Rejected: target node does not exist in the source sample registry."}
                  </dd>
                  <dt>Unexecuted checks</dt>
                  <dd>Semantic deduplication · contamination audit · expert review</dd>
                </dl>
              </div>
            </div>
          ) : (
            <p>No source samples are available. Candidate generation is disabled.</p>
          )}
        </div>
      )}

      {tab === "evaluation" && (
        <div className={css.evaluation}>
          <div className={css.batchHeader}>
            <div>
              <h3>Checkpoint acceptance</h3>
              <p>
                Simulated evaluation at step{" "}
                {snapshot.evaluationStep.toLocaleString("en-US")} · values update on
                evaluation completion
              </p>
            </div>
            <span className={css.hold}>Production release: unvalidated</span>
          </div>
          <div className={css.gates}>
            {snapshot.gates.map((gate) => (
              <div key={gate.label}>
                <span>{gate.label}</span>
                <strong>{gate.value.toFixed(gate.digits)}</strong>
                <span>
                  Target {gate.direction === "up" ? "≥" : "≤"}{" "}
                  {gate.target.toFixed(gate.digits)}
                </span>
                <b data-pass={gate.pass}>{gate.pass ? "Replay pass" : "Replay hold"}</b>
              </div>
            ))}
          </div>
          <p>{recipe.evaluation}</p>
          <p className={css.note}>
            No measured benchmark run, confidence interval or serving profile is attached.
            Simulated gates cannot authorize production release.
          </p>
        </div>
      )}

      <footer className={css.footer}>
        <p>{recipe.caveat}</p>
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
