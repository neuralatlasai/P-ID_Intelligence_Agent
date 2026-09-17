import { batchRewards, objectiveShares } from "./ingestion";
import { curveAt } from "./run";
import type { Stage } from "./stages";

export interface TrainingSignal {
  readonly id: string;
  readonly label: string;
  readonly colour: string;
  readonly value: number;
  readonly weight: number | undefined;
  readonly contribution: number | undefined;
  readonly history: readonly number[];
  readonly derived: boolean;
}

export interface SignalSnapshot {
  readonly kind: "loss" | "reward" | "unweighted";
  readonly signals: readonly TrainingSignal[];
  readonly total: number | undefined;
  readonly start: number;
  readonly end: number;
}

const POINTS = 32;
const MAX_SIGNALS = 8;
const PALETTE = [
  "#285d83",
  "#487d75",
  "#706590",
  "#a07739",
  "#6f8195",
  "#407e91",
  "#a55656",
  "#6a7054",
];

/**
 * Consume the same simulated functions as the recipe, reward and curve panels. No new
 * synthetic telemetry or KD weights. Sample only elapsed steps; the chart never forecasts.
 * Catalogs are bounded at eight signals and histories at 32 points: O(K × P), bounded
 * allocation per update. Keeping the small histories contiguous avoids chart-library state.
 */
export function trainingSignals(stage: Stage, step: number): SignalSnapshot {
  const end = Math.min(stage.run.totalSteps, Math.max(0, Number.isFinite(step) ? step : 0));
  const start = Math.max(0, end - Math.min(4000, stage.run.totalSteps));
  const steps = Array.from(
    { length: POINTS },
    (_, index) => start + ((end - start) * index) / (POINTS - 1),
  );

  if (stage.id === "rl") {
    const current = batchRewards(stage, end, end / stage.run.totalSteps).slice(
      0,
      MAX_SIGNALS,
    );
    const history = steps.map((at) => batchRewards(stage, at, at / stage.run.totalSteps));
    const signals = current.map((row, index) => ({
      id: row.name,
      label: row.name.replace(/ reward$| penalty$/, ""),
      colour: row.weight < 0 ? "#a55656" : PALETTE[index % PALETTE.length]!,
      value: row.score,
      weight: row.weight,
      contribution: row.value,
      history: history.map((batch) => batch[index]?.score ?? 0),
      derived: false,
    }));
    return {
      kind: "reward",
      signals,
      total: signals.reduce((sum, signal) => sum + (signal.contribution ?? 0), 0),
      start,
      end,
    };
  }

  const objectives = objectiveShares(stage, end).slice(0, MAX_SIGNALS);
  if (objectives.length) {
    const history = steps.map((at) => objectiveShares(stage, at));
    const signals = objectives.map((row, index) => ({
      id: row.key,
      label: row.label,
      colour: PALETTE[index % PALETTE.length]!,
      value: row.loss,
      weight: row.weight,
      contribution: row.weight * row.loss,
      history: history.map((batch) => batch[index]?.loss ?? 0),
      derived: row.derived,
    }));
    return {
      kind: "loss",
      signals,
      total: signals.reduce((sum, signal) => sum + (signal.contribution ?? 0), 0),
      start,
      end,
    };
  }

  const signals = (stage.curves[0]?.curves ?? [])
    .slice(0, MAX_SIGNALS)
    .map((curve, index) => ({
      id: curve.key,
      label: curve.label,
      colour: PALETTE[index % PALETTE.length]!,
      value: curveAt(curve, end),
      weight: undefined,
      contribution: undefined,
      history: steps.map((at) => curveAt(curve, at)),
      derived: false,
    }));
  return { kind: "unweighted", signals, total: undefined, start, end };
}

/** Normalize each micro-chart to its own local range, never across unlike objectives. */
export function signalPolyline(values: readonly number[]): string {
  const bounded = values.slice(0, POINTS);
  if (!bounded.length) return "";
  const low = Math.min(...bounded);
  const high = Math.max(...bounded);
  const span = high - low;
  return bounded
    .map((value, index) => {
      const x = 4 + (index * 192) / Math.max(1, bounded.length - 1);
      const y = span > 1e-12 ? 45 - ((value - low) * 36) / span : 27;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
