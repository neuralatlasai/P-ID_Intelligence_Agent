"use client";

import { useMemo, useState, type CSSProperties } from "react";

import { termLabel } from "@/lib/modellab/architecture";
import type { LabSample } from "@/lib/modellab/samples";
import {
  signalPolyline,
  trainingSignals,
  type SignalSnapshot,
  type TrainingSignal,
} from "@/lib/modellab/signals";
import { frameAt, MAX_GRAD_NORM } from "@/lib/modellab/telemetry";
import { scaleColour, seriesColour } from "@/lib/series";

import type { LiveCardProps } from "./live";
import css from "./TrainingDynamics.module.css";

const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const value = (input: number) =>
  Math.abs(input) < 0.001 && input !== 0 ? input.toExponential(2) : input.toFixed(4);
const compactStep = (step: number) =>
  step >= 10_000 ? `${(step / 1000).toFixed(1)}k` : number(step);

/** Steps of the snapshot's history, as `trainingSignals` samples them. */
function historySteps(snapshot: SignalSnapshot): number[] {
  const points = snapshot.signals[0]?.history.length ?? 0;
  return Array.from({ length: points }, (_, index) =>
    Math.round(
      snapshot.start + ((snapshot.end - snapshot.start) * index) / Math.max(1, points - 1),
    ),
  );
}

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
      <path d="M4 45H196 M4 9H196" className={css.gridLine} />
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

// ── the stacked composition ──────────────────────────────────────────────────────────────

const CW = 640;
const CH = 196;
const PAD = { left: 8, right: 12, top: 14, bottom: 24 } as const;

interface Band {
  readonly signal: TrainingSignal;
  readonly index: number;
  readonly d: string;
}

/**
 * Weighted contributions over the window, stacked: each band is λᵢ·Lᵢ(t), so the top edge is
 * the weighted total the run logs. Reward stacks its positive terms above zero and its
 * penalties below, with the net drawn as a line.
 */
function composition(snapshot: SignalSnapshot) {
  const steps = historySteps(snapshot);
  const n = steps.length;
  const weighted = snapshot.signals.map((signal) =>
    signal.history.map((loss) => (signal.weight ?? 0) * loss),
  );
  const up = new Array<number>(n).fill(0);
  const down = new Array<number>(n).fill(0);
  const edges = weighted.map((series) =>
    series.map((contribution, t) => {
      const base = contribution >= 0 ? up[t]! : down[t]!;
      const top = base + contribution;
      if (contribution >= 0) up[t] = top;
      else down[t] = top;
      return [base, top] as const;
    }),
  );
  const net = up.map((value, t) => value + down[t]!);
  const high = Math.max(1e-9, ...up) * 1.08;
  const low = Math.min(0, ...down) * 1.15;
  const x = (t: number) =>
    PAD.left + ((CW - PAD.left - PAD.right) * t) / Math.max(1, n - 1);
  const y = (v: number) =>
    PAD.top + ((CH - PAD.top - PAD.bottom) * (high - v)) / Math.max(1e-12, high - low);
  const bands: Band[] = snapshot.signals.map((signal, index) => {
    const edge = edges[index]!;
    const upper = edge.map(([, top], t) => `${x(t).toFixed(1)},${y(top).toFixed(1)}`);
    const lower = edge
      .map(([base], t) => `${x(t).toFixed(1)},${y(base).toFixed(1)}`)
      .reverse();
    return { signal, index, d: `M${upper.join(" L")} L${lower.join(" L")} Z` };
  });
  const netPath = `M${net.map((v, t) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}`;
  return { steps, bands, netPath, high, low, x, y, net };
}

/**
 * Loss (or reward) against the pre-clip gradient norm over the same window: the trajectory of
 * the run in the plane the two logged optimisation signals span. Older steps fade; the
 * newest is the step the console printed last. The clip threshold is drawn when in range.
 */
function Descent({
  points,
  kind,
}: {
  readonly points: readonly { readonly g: number; readonly l: number }[];
  readonly kind: SignalSnapshot["kind"];
}) {
  const finite = points.filter((p) => Number.isFinite(p.g) && Number.isFinite(p.l));
  if (finite.length < 2) return null;
  const W = 220;
  const H = CH;
  const pad = { left: 38, right: 10, top: 12, bottom: 24 };
  const gMax = Math.max(...finite.map((p) => p.g)) * 1.1;
  const gMin = Math.min(...finite.map((p) => p.g)) * 0.9;
  const lMax = Math.max(...finite.map((p) => p.l));
  const lMin = Math.min(...finite.map((p) => p.l));
  const lSpan = Math.max(1e-9, lMax - lMin);
  const x = (g: number) =>
    pad.left + ((W - pad.left - pad.right) * (g - gMin)) / Math.max(1e-9, gMax - gMin);
  const y = (l: number) =>
    pad.top + ((H - pad.top - pad.bottom) * (lMax + 0.06 * lSpan - l)) / (lSpan * 1.12);
  const last = finite.at(-1)!;
  const clipX =
    MAX_GRAD_NORM <= gMax && MAX_GRAD_NORM >= gMin ? x(MAX_GRAD_NORM) : undefined;
  const axis = kind === "reward" ? "R" : "L";
  return (
    <svg
      className={css.descent}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Trajectory of ${kind === "reward" ? "reward" : "loss"} against gradient norm over the window: now ${value(last.l)} at gradient norm ${last.g.toFixed(3)}`}
    >
      <path
        className={css.axis}
        d={`M${pad.left},${pad.top} V${H - pad.bottom} H${W - pad.right}`}
      />
      {clipX !== undefined && (
        <path className={css.clip} d={`M${clipX},${pad.top} V${H - pad.bottom}`} />
      )}
      <polyline
        className={css.trajectory}
        points={finite.map((p) => `${x(p.g).toFixed(1)},${y(p.l).toFixed(1)}`).join(" ")}
      />
      {finite.map((p, i) => (
        <circle
          key={i}
          cx={x(p.g)}
          cy={y(p.l)}
          r={i === finite.length - 1 ? 3.6 : 1.8}
          style={{ fill: scaleColour((i + 1) / finite.length) }}
        />
      ))}
      <text className={css.tick} x={pad.left - 6} y={pad.top + 4} textAnchor="end">
        {value(lMax)}
      </text>
      <text className={css.tick} x={pad.left - 6} y={H - pad.bottom} textAnchor="end">
        {value(lMin)}
      </text>
      <text className={css.tick} x={pad.left} y={H - 8}>
        {gMin.toFixed(2)}
      </text>
      <text className={css.tick} x={W - pad.right} y={H - 8} textAnchor="end">
        {gMax.toFixed(2)}
      </text>
      <text className={css.axisLabel} x={pad.left + 4} y={pad.top + 4}>
        {axis}
      </text>
      <text
        className={css.axisLabel}
        x={W - pad.right - 2}
        y={H - pad.bottom - 5}
        textAnchor="end"
      >
        ‖g‖
      </text>
    </svg>
  );
}

/**
 * Figure 04: the composition of the learning signal. A stacked area of each term's weighted
 * contribution over the recent window, whose top edge is the total the run console logs and
 * figure 03's aggregate reads; a small multiple per term on its own scale; and the run's
 * trajectory in the loss–gradient-norm plane. Everything reads the same simulated functions
 * as the recipe, reward and curve panels.
 */
export function TrainingDynamics({
  stage,
  step,
  running,
  config,
  profile,
}: LiveCardProps & {
  readonly sample: LabSample | undefined;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const snapshot = useMemo(() => trainingSignals(stage, step), [stage, step]);
  const chart = useMemo(
    () => (snapshot.kind === "unweighted" ? undefined : composition(snapshot)),
    [snapshot],
  );
  const steps = useMemo(() => historySteps(snapshot), [snapshot]);
  const trajectory = useMemo(() => {
    const context = { stage, profile, config };
    return steps.map((at) => {
      const frame = frameAt(context, Math.max(1, at));
      return { g: frame.gradNorm, l: frame.loss };
    });
  }, [stage, profile, config, steps]);
  // One colour per channel, fixed by its place in the catalogue, so the band, the legend
  // swatch and the small multiple all name the same channel.
  const colourOf = (signal: TrainingSignal) =>
    seriesColour(snapshot.signals.findIndex((item) => item.id === signal.id));
  const positiveTotal = snapshot.signals.reduce(
    (sum, signal) => sum + Math.max(0, signal.contribution ?? 0),
    0,
  );
  const unit = snapshot.kind === "reward" ? "score" : "loss";
  const kindName = snapshot.kind === "reward" ? "positive reward" : "weighted loss";

  return (
    <section
      className={css.root}
      aria-label="Training signal workbench"
      data-running={running}
    >
      <div className={css.composition}>
        <div className={css.compositionHeading}>
          <div>
            <span className={css.kicker}>FIGURE 04 · SIGNAL COMPOSITION</span>
            <h4>
              {snapshot.kind === "reward"
                ? "Reward"
                : snapshot.kind === "unweighted"
                  ? "Transfer signals"
                  : "Weighted loss"}
            </h4>
          </div>
          <div
            className={css.total}
            role="img"
            aria-label={
              snapshot.total === undefined
                ? "Total unspecified"
                : `${snapshot.kind === "reward" ? "Net weighted reward" : "Weighted loss"} ${value(snapshot.total)} at step ${number(snapshot.end)}`
            }
          >
            <span aria-hidden="true">{snapshot.kind === "reward" ? "Σ λ·r" : "Σ λ·L"}</span>
            <strong aria-hidden="true">
              {snapshot.total === undefined ? "—" : value(snapshot.total)}
            </strong>
          </div>
        </div>

        <div className={css.plots}>
          {chart ? (
            <svg
              className={css.stackChart}
              viewBox={`0 0 ${CW} ${CH}`}
              role="img"
              aria-label={`Weighted contribution of each term, steps ${number(snapshot.start)} to ${number(snapshot.end)}; total now ${value(snapshot.total ?? 0)}`}
            >
              <path
                className={css.axis}
                d={`M${PAD.left},${PAD.top} V${CH - PAD.bottom} H${CW - PAD.right}`}
              />
              {chart.low < 0 && (
                <path
                  className={css.zero}
                  d={`M${PAD.left},${chart.y(0)} H${CW - PAD.right}`}
                />
              )}
              {chart.bands.map((band) => (
                <path
                  key={band.signal.id}
                  className={css.band}
                  d={band.d}
                  data-penalty={(band.signal.contribution ?? 0) < 0 || undefined}
                  data-dim={
                    (selected !== undefined && selected !== band.signal.id) || undefined
                  }
                  style={{
                    fill: seriesColour(band.index),
                    stroke: seriesColour(band.index),
                  }}
                />
              ))}
              <path className={css.netLine} d={chart.netPath} />
              <circle
                className={css.netDot}
                cx={chart.x(chart.net.length - 1)}
                cy={chart.y(chart.net.at(-1) ?? 0)}
                r={3.2}
              />
              {/* Value ticks sit inside the plot, above their level. */}
              <path
                className={css.zero}
                d={`M${PAD.left},${chart.y(chart.high / 1.08)} H${CW - PAD.right}`}
              />
              <text
                className={css.tick}
                x={PAD.left + 4}
                y={chart.y(chart.high / 1.08) - 4}
              >
                {value(chart.high / 1.08)}
              </text>
              <text className={css.tick} x={PAD.left} y={CH - 6}>
                {compactStep(snapshot.start)}
              </text>
              <text className={css.tick} x={CW - PAD.right} y={CH - 6} textAnchor="end">
                {compactStep(snapshot.end)}
              </text>
              <text
                className={css.axisLabel}
                x={(PAD.left + CW - PAD.right) / 2}
                y={CH - 6}
                textAnchor="middle"
              >
                step
              </text>
            </svg>
          ) : (
            <span className={css.chipLine}>
              <span className={css.chip}>unweighted</span>
            </span>
          )}
          <Descent points={trajectory} kind={snapshot.kind} />
        </div>

        {chart && (
          <div
            className={css.legend}
            role="group"
            aria-label="Weighted signal contributions"
          >
            {snapshot.signals.map((signal, index) => {
              const contribution = signal.contribution ?? 0;
              const share =
                contribution >= 0 && positiveTotal > 0
                  ? (100 * contribution) / positiveTotal
                  : undefined;
              return (
                <button
                  type="button"
                  key={signal.id}
                  aria-label={
                    share !== undefined
                      ? `${signal.label}: ${share.toFixed(1)} percent of ${kindName}`
                      : `${signal.label}: penalty ${value(Math.abs(contribution))}`
                  }
                  aria-pressed={selected === signal.id}
                  onClick={() =>
                    setSelected((current) =>
                      current === signal.id ? undefined : signal.id,
                    )
                  }
                  style={{ "--signal": seriesColour(index) } as CSSProperties}
                >
                  <i aria-hidden="true" data-penalty={contribution < 0 || undefined} />
                  <span aria-hidden="true">{termLabel(signal.id, signal.label)}</span>
                  <b aria-hidden="true">
                    {share !== undefined
                      ? `${share.toFixed(0)}%`
                      : `−${value(Math.abs(contribution))}`}
                  </b>
                </button>
              );
            })}
          </div>
        )}

        <div className={css.signals}>
          {snapshot.signals.map((signal) => (
            <button
              type="button"
              key={signal.id}
              className={css.signal}
              aria-pressed={selected === signal.id}
              aria-label={`${signal.label}: ${unit} ${value(signal.value)}${signal.weight === undefined ? "" : `, weight ${signal.weight.toFixed(2)}, contribution ${value(signal.contribution ?? 0)}`}`}
              onClick={() =>
                setSelected((current) => (current === signal.id ? undefined : signal.id))
              }
              style={{ "--signal": colourOf(signal) } as CSSProperties}
            >
              <span className={css.signalHeading} aria-hidden="true">
                <i />
                <strong>{termLabel(signal.id, signal.label)}</strong>
                {signal.derived ? <small>derived</small> : null}
              </span>
              <span className={css.signalValue} aria-hidden="true">
                {value(signal.value)}
                <small>{unit}</small>
              </span>
              <MicroChart signal={signal} colour={colourOf(signal)} />
              <span className={css.signalMeta} aria-hidden="true">
                <span>
                  {signal.weight === undefined
                    ? "λ —"
                    : `λ ${signal.weight < 0 ? "−" : ""}${Math.abs(signal.weight).toFixed(2)}`}
                </span>
                {signal.contribution !== undefined && (
                  <span>
                    {`${signal.contribution < 0 ? "−" : "+"}${value(Math.abs(signal.contribution))}`}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        <footer className={css.chartNote}>
          <code>
            {number(snapshot.start)}–{number(snapshot.end)}
          </code>
          <span className={css.chip} aria-label="Simulated telemetry">
            simulated
          </span>
        </footer>
      </div>
    </section>
  );
}
