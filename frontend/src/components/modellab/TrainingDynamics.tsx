"use client";

import { useMemo, useState, type CSSProperties } from "react";

import type { LabSample } from "@/lib/modellab/samples";
import {
  signalPolyline,
  trainingSignals,
  type TrainingSignal,
} from "@/lib/modellab/signals";

import type { LiveCardProps } from "./live";
import css from "./TrainingDynamics.module.css";
import { seriesColour } from "@/lib/series";

const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const value = (input: number) =>
  Math.abs(input) < 0.001 && input !== 0 ? input.toExponential(2) : input.toFixed(4);

function MicroChart({
  signal,
  colour,
}: {
  readonly signal: TrainingSignal;
  readonly colour: string;
}) {
  const points = signalPolyline(signal.history);
  const last = points.split(" ").at(-1)?.split(",") ?? ["196", "27"];
  return (
    <svg
      className={css.microChart}
      viewBox="0 0 200 54"
      role="img"
      aria-label={`${signal.label}: ${value(signal.history[0] ?? 0)} to ${value(signal.value)}, simulated local history`}
    >
      <path d="M4 45H196 M4 27H196 M4 9H196" className={css.gridLine} />
      <polyline
        points={points}
        fill="none"
        stroke={colour}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={colour} />
    </svg>
  );
}

/**
 * The sequence contract and the composition of the learning signal. The reference path
 * through the model lives in the architecture figure above; this panel reads the same
 * simulated losses and rewards as the recipe, reward and curve panels.
 */
export function TrainingDynamics({
  stage,
  config,
  step,
  running,
}: LiveCardProps & {
  readonly sample: LabSample | undefined;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const snapshot = useMemo(() => trainingSignals(stage, step), [stage, step]);
  // One colour per channel, fixed by its place in the catalogue, so the stack segment, the
  // card, its micro-chart and the inspection swatch all name the same channel.
  const colourOf = (signal: TrainingSignal) =>
    seriesColour(snapshot.signals.findIndex((item) => item.id === signal.id));
  const inspected =
    snapshot.signals.find((signal) => signal.id === selected) ?? snapshot.signals[0];
  const positive = snapshot.signals.filter((signal) => (signal.contribution ?? 0) > 0);
  const positiveTotal = positive.reduce(
    (sum, signal) => sum + (signal.contribution ?? 0),
    0,
  );
  const penalty = snapshot.signals.reduce(
    (sum, signal) => sum + Math.min(0, signal.contribution ?? 0),
    0,
  );
  const packing =
    stage.id === "pretraining"
      ? [
          ["SOURCE", "Identity"],
          ["VISION", "Patch embeddings"],
          ["GRAPH", config.graph === "none" ? "Topology text" : "Graph embeddings"],
          ["TARGET", "Masked / paired"],
        ]
      : [
          ["SYSTEM", "Loss masked"],
          ["EVIDENCE", "Conditioning"],
          ["INSTRUCTION", "Loss masked"],
          [
            stage.id === "rl" ? "ROLLOUT" : "RESPONSE",
            stage.id === "rl" ? "Reward scored" : "Supervised",
          ],
        ];

  return (
    <section
      className={css.root}
      aria-label="Training signal workbench"
      data-running={running}
    >
      <div className={css.tokenFlow}>
        <div>
          <span className={css.kicker}>FIGURE 04 · SEQUENCE CONTRACT</span>
          <p>Ordered spans, not measured token counts.</p>
        </div>
        <ol aria-label="Token flow contract">
          {packing.map(([label, description], index) => (
            <li key={label} data-target={index === packing.length - 1}>
              <strong>{label}</strong>
              <small>{description}</small>
            </li>
          ))}
        </ol>
      </div>

      <div className={css.composition}>
        <div className={css.compositionHeading}>
          <div>
            <span className={css.kicker}>FIGURE 05 · SIGNAL COMPOSITION</span>
            <h4>
              {snapshot.kind === "reward"
                ? "Reward components"
                : snapshot.kind === "unweighted"
                  ? "Independent transfer signals"
                  : "What drives the update"}
            </h4>
          </div>
          <div className={css.total}>
            <span>
              {snapshot.kind === "reward"
                ? "Net weighted reward"
                : snapshot.kind === "unweighted"
                  ? "Weighted objective"
                  : "Weighted signal sum"}
            </span>
            <strong>
              {snapshot.total === undefined ? "Unspecified" : value(snapshot.total)}
            </strong>
          </div>
        </div>

        {snapshot.kind !== "unweighted" ? (
          <>
            <div className={css.stackHeader}>
              <span>
                {snapshot.kind === "reward"
                  ? "Positive reward contribution"
                  : "Share of weighted signal sum"}
              </span>
              <span>Select a channel to inspect</span>
            </div>
            <div
              className={css.stack}
              role="group"
              aria-label="Weighted signal contributions"
            >
              {positive.map((signal) => (
                <button
                  type="button"
                  key={signal.id}
                  aria-label={`${signal.label}: ${((100 * (signal.contribution ?? 0)) / positiveTotal).toFixed(1)} percent of ${snapshot.kind === "reward" ? "positive reward" : "weighted loss"}`}
                  aria-pressed={inspected?.id === signal.id}
                  onClick={() => setSelected(signal.id)}
                  style={{
                    flexGrow: (signal.contribution ?? 0) / positiveTotal,
                    backgroundColor: colourOf(signal),
                  }}
                />
              ))}
            </div>
            {snapshot.kind === "reward" && (
              <p className={css.penalty}>
                Positive {value(positiveTotal)} <span>−</span> penalty{" "}
                {value(Math.abs(penalty))} <span>=</span> net {value(snapshot.total ?? 0)}.
                Penalties remain separate from positive shares.
              </p>
            )}
          </>
        ) : (
          <p className={css.unweighted}>
            Loss weights are not configured. Each channel is shown independently; no
            combined score or contribution percentages are implied.
          </p>
        )}

        <div className={css.signals}>
          {snapshot.signals.map((signal, index) => (
            <button
              type="button"
              key={signal.id}
              className={css.signal}
              aria-pressed={inspected?.id === signal.id}
              onClick={() => setSelected(signal.id)}
              style={{ "--signal": colourOf(signal) } as CSSProperties}
            >
              <span className={css.signalHeading}>
                <i />
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{signal.label}</strong>
              </span>
              <span className={css.signalValue}>
                {value(signal.value)}
                <small>{snapshot.kind === "reward" ? "score" : "loss"}</small>
              </span>
              <MicroChart signal={signal} colour={colourOf(signal)} />
              <span className={css.signalMeta}>
                <span>
                  {signal.weight === undefined
                    ? "Weight unspecified"
                    : `Weight ${signal.weight.toFixed(2)}`}
                </span>
                <span>
                  {signal.contribution === undefined
                    ? "Independent"
                    : `Weighted ${value(signal.contribution)}`}
                </span>
              </span>
            </button>
          ))}
        </div>

        {inspected && (
          <div className={css.inspection}>
            <span style={{ backgroundColor: colourOf(inspected) }} />
            <strong>{inspected.label}</strong>
            <p>
              {inspected.weight === undefined
                ? "Observed simulated curve; a weighted contribution cannot be computed without a configured coefficient."
                : `${value(inspected.value)} ${snapshot.kind === "reward" ? "score" : "loss"} × ${inspected.weight.toFixed(2)} weight → ${value(inspected.contribution ?? 0)} contribution.`}
              {inspected.derived
                ? " Derived companion curve; not separately plotted in the training chart."
                : " Uses the same simulation as the stage's training charts."}
            </p>
          </div>
        )}
        <footer className={css.chartNote}>
          <span>CONVERGENCE WINDOW</span>
          <code>
            {number(snapshot.start)}–{number(snapshot.end)} steps
          </code>
          <p>
            32 samples per channel · local y-scale per chart · simulated values · no
            forecast
          </p>
        </footer>
      </div>
    </section>
  );
}
