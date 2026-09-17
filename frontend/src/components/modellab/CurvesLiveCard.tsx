"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { checkpointMarkers, emaSmooth, evalMarkers } from "@/lib/modellab/evaluation";
import { curveAt, formatSteps, learningRateAt } from "@/lib/modellab/run";
import type { CurveSpec, CurveTab, RunSpec } from "@/lib/modellab/stages";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import base from "./ModelLab.module.css";
import styles from "./CurvesLiveCard.module.css";

const HEIGHT = 216;
/** Roughly how many samples each series carries up to the current step. */
const TARGET_POINTS = 200;
/** Minimum horizontal spacing, in CSS pixels, between drawn markers. */
const MARKER_GAP = 8;
/** How close, in CSS pixels, the pointer must be for the crosshair to snap to a marker. */
const SNAP = 6;
const LR_COLOUR = "#64748b";

const number = (value: number) => value.toLocaleString("en-US");

/** A compact reading: three significant figures without trailing zeros. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(3)));
}

function formatRate(value: number): string {
  return value === 0 ? "0" : value.toExponential(1).replace("e-", "e−");
}

/** Wall-clock distance behind the head, in training time at the configured throughput. */
function approxAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "≈ <1m ago";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `≈ ${days}d ${hours}h ago`;
  if (hours > 0) return `≈ ${hours}h ${minutes}m ago`;
  return `≈ ${minutes}m ago`;
}

/** The smallest 1-2-5 stride that keeps the grid at or under the target point count. */
function strideFor(upTo: number): number {
  const raw = Math.max(1, upTo / TARGET_POINTS);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const factor of [1, 2, 5, 10]) {
    if (factor * magnitude >= raw) return factor * magnitude;
  }
  return 10 * magnitude;
}

interface Built {
  readonly steps: readonly number[];
  readonly stride: number;
  readonly raw: ReadonlyMap<string, readonly number[]>;
  readonly lr: readonly number[];
}

/**
 * Samples on a fixed stride so points already drawn keep their positions and values as the
 * run advances; only the head sample moves.
 */
function buildSeries(tab: CurveTab, run: RunSpec, head: number): Built {
  const stride = strideFor(head);
  const steps: number[] = [];
  for (let s = 0; s < head; s += stride) steps.push(s);
  steps.push(head);
  const raw = new Map<string, number[]>();
  for (const curve of tab.curves) {
    raw.set(
      curve.key,
      steps.map((s) => curveAt(curve, s)),
    );
  }
  return { steps, stride, raw, lr: steps.map((s) => learningRateAt(run, s)) };
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const rough = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step =
    [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((candidate) => candidate >= rough) ??
    10 * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

function nearestIndex(steps: readonly number[], target: number): number {
  let best = 0;
  for (let index = 1; index < steps.length; index += 1) {
    if (Math.abs(steps[index]! - target) < Math.abs(steps[best]! - target)) best = index;
  }
  return best;
}

interface Marker {
  readonly step: number;
  readonly evaluation: boolean;
  readonly checkpoint: boolean;
}

export function CurvesLiveCard({ stage, step, running }: LiveCardProps) {
  const ids = useId();
  const { run } = stage;
  const total = run.totalSteps;
  const [tabId, setTabId] = useState(stage.curves[0]!.id);
  const tab = stage.curves.find((item) => item.id === tabId) ?? stage.curves[0]!;
  const [logScale, setLogScale] = useState(true);
  const [showLr, setShowLr] = useState(false);
  const [smoothing, setSmoothing] = useState(0.6);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number>();
  const log = tab.log && logScale;

  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const head = Math.min(total, Math.max(0, Math.floor(step)));
  const built = useMemo(() => buildSeries(tab, run, head), [tab, run, head]);
  const smoothed = useMemo(() => {
    const out = new Map<string, readonly number[]>();
    for (const curve of tab.curves) {
      const values = built.raw.get(curve.key) ?? [];
      out.set(curve.key, curve.dashed ? values : emaSmooth(values, smoothing));
    }
    return out;
  }, [built, tab, smoothing]);
  const markers = useMemo<readonly Marker[]>(() => {
    const byStep = new Map<number, { evaluation: boolean; checkpoint: boolean }>();
    for (const at of evalMarkers(stage, head)) {
      byStep.set(at, { evaluation: true, checkpoint: false });
    }
    for (const at of checkpointMarkers(stage, head)) {
      byStep.set(at, { evaluation: byStep.get(at)?.evaluation ?? false, checkpoint: true });
    }
    return [...byStep.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, kind]) => ({ step: at, ...kind }));
  }, [stage, head]);
  const plannedLr = useMemo(
    () =>
      Array.from({ length: 61 }, (_, index) => {
        const s = head + ((total - head) * index) / 60;
        return { step: s, value: learningRateAt(run, s) };
      }),
    [run, head, total],
  );

  const visible = tab.curves.filter((curve) => !hidden.has(curve.key));

  // ── geometry ──────────────────────────────────────────────────────────────────────────────
  const pad = { left: 46, right: showLr ? 54 : 14, top: 12, bottom: 36 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = HEIGHT - pad.top - pad.bottom;
  const x = (s: number) => pad.left + (s / total) * plotW;

  const domainCurves = visible.length ? visible : tab.curves;
  const domainValues = domainCurves
    .flatMap((curve) => [
      ...(built.raw.get(curve.key) ?? []),
      ...(smoothed.get(curve.key) ?? []),
    ])
    .filter((v) => Number.isFinite(v) && (!log || v > 0));
  const lo = domainValues.length ? Math.min(...domainValues) : 0;
  const hi = domainValues.length ? Math.max(...domainValues) : 1;
  let yMin: number;
  let yMax: number;
  if (log) {
    yMin = Math.pow(10, Math.floor(Math.log10(Math.max(lo, 1e-9))));
    yMax = Math.pow(10, Math.ceil(Math.log10(Math.max(hi, 1e-9))));
    if (yMax <= yMin) yMax = yMin * 10;
  } else {
    const margin = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    yMin = lo >= 0 ? Math.max(0, lo - margin) : lo - margin;
    yMax = hi + margin;
  }
  const y = (v: number) => {
    const t = log
      ? (Math.log10(Math.max(v, yMin)) - Math.log10(yMin)) /
        (Math.log10(yMax) - Math.log10(yMin))
      : (v - yMin) / (yMax - yMin);
    return pad.top + (1 - Math.min(1.02, Math.max(-0.02, t))) * plotH;
  };
  const lrMax = run.learningRate || 1;
  const yLr = (v: number) => pad.top + (1 - v / lrMax) * plotH;

  const yTicks = log
    ? Array.from(
        { length: Math.round(Math.log10(yMax / yMin)) + 1 },
        (_, i) => yMin * Math.pow(10, i),
      )
    : niceTicks(yMin, yMax, 4);
  const xTicks = Array.from({ length: 6 }, (_, i) => (total * i) / 5);

  const path = (values: readonly number[]) =>
    values
      .map((v, i) => `${i ? "L" : "M"}${x(built.steps[i]!).toFixed(1)},${y(v).toFixed(1)}`)
      .join("");

  // Thin markers so they never crowd closer than MARKER_GAP pixels; checkpoints win.
  const drawnMarkers: Marker[] = [];
  for (const marker of markers) {
    const previous = drawnMarkers.at(-1);
    if (!previous || x(marker.step) - x(previous.step) >= MARKER_GAP) {
      drawnMarkers.push(marker);
    } else if (marker.checkpoint && !previous.checkpoint) {
      drawnMarkers[drawnMarkers.length - 1] = marker;
    }
  }

  // ── hover ─────────────────────────────────────────────────────────────────────────────────
  const hovered = hover === undefined ? undefined : Math.min(head, Math.max(0, hover));
  const hoverIndex = hovered === undefined ? undefined : nearestIndex(built.steps, hovered);
  const hoverMarkers =
    hovered === undefined
      ? []
      : drawnMarkers.filter((marker) => Math.abs(x(marker.step) - x(hovered)) <= 0.5);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const s = ((px - pad.left) / plotW) * total;
    if (s < -total * 0.01 || s > total) {
      setHover(undefined);
      return;
    }
    const near = drawnMarkers.find((marker) => Math.abs(x(marker.step) - px) <= SNAP);
    setHover(near ? near.step : Math.min(head, Math.max(0, s)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = hovered ?? head;
    const jump = event.shiftKey ? built.stride * 10 : built.stride;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = Math.max(0, current - jump);
    else if (event.key === "ArrowRight") next = Math.min(head, current + jump);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = head;
    else if (event.key === "Escape") {
      setHover(undefined);
      return;
    } else return;
    event.preventDefault();
    setHover(next);
  };

  const headValue = (curve: CurveSpec) =>
    smoothed.get(curve.key)?.at(-1) ?? curveAt(curve, head);
  const summary = `${tab.label} up to step ${number(head)} of ${number(total)}: ${visible
    .map((curve) => `${curve.label} ${formatValue(headValue(curve))}`)
    .join(", ")}`;

  const tipWidth = 200;
  const tipLeft =
    hovered === undefined
      ? 0
      : x(hovered) + 12 + tipWidth > width
        ? Math.max(0, x(hovered) - 12 - tipWidth)
        : x(hovered) + 12;

  const selectTab = (id: string) => {
    setTabId(id);
    setHidden(new Set());
    setHover(undefined);
  };

  return (
    <Card
      title={stage.id === "distillation" ? "Distillation curves" : "Training curves"}
      icon="pulse"
      aside={
        <span className={styles.aside}>
          <span className={styles.simulated}>Simulated run</span>
          <span className={styles.stepNote}>step {number(head)}</span>
        </span>
      }
    >
      <div
        className={base.tabs}
        role="tablist"
        aria-label="Curve set"
        onKeyDown={(event) => {
          const index = stage.curves.findIndex((item) => item.id === tab.id);
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % stage.curves.length;
          else if (event.key === "ArrowLeft")
            next = (index - 1 + stage.curves.length) % stage.curves.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = stage.curves.length - 1;
          else return;
          event.preventDefault();
          const target = stage.curves[next]!;
          selectTab(target.id);
          document.getElementById(`${ids}-tab-${target.id}`)?.focus();
        }}
      >
        {stage.curves.map((item) => (
          <button
            key={item.id}
            id={`${ids}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={item.id === tab.id}
            aria-controls={`${ids}-panel`}
            tabIndex={item.id === tab.id ? 0 : -1}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        id={`${ids}-panel`}
        role="tabpanel"
        aria-labelledby={`${ids}-tab-${tab.id}`}
        className={styles.panel}
      >
        <div className={styles.toolbar}>
          {tab.log ? (
            <label className={styles.control}>
              <input
                type="checkbox"
                checked={logScale}
                onChange={(event) => setLogScale(event.target.checked)}
              />
              Log scale
            </label>
          ) : null}
          <label className={styles.control}>
            <input
              type="checkbox"
              checked={showLr}
              onChange={(event) => setShowLr(event.target.checked)}
            />
            LR schedule
          </label>
          <label className={styles.control} htmlFor={`${ids}-smoothing`}>
            Smoothing
          </label>
          <input
            id={`${ids}-smoothing`}
            className={styles.slider}
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={smoothing}
            aria-valuetext={`${smoothing.toFixed(2)} exponential moving average weight`}
            onChange={(event) => setSmoothing(Number(event.target.value))}
          />
          <output htmlFor={`${ids}-smoothing`} className={styles.sliderValue}>
            {smoothing.toFixed(2)}
          </output>
        </div>

        <div className={base.curvesBody}>
          <div
            ref={host}
            className={styles.chart}
            tabIndex={0}
            role="group"
            aria-label={`${tab.label} chart. Arrow keys inspect values at earlier steps; Escape closes the readout.`}
            onKeyDown={onKeyDown}
            onBlur={() => setHover(undefined)}
          >
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              aria-label={summary}
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(undefined)}
            >
              {yTicks.map((v) => (
                <g key={v}>
                  <line
                    x1={pad.left}
                    x2={pad.left + plotW}
                    y1={y(v)}
                    y2={y(v)}
                    className={base.gridLine}
                  />
                  <text
                    x={pad.left - 6}
                    y={y(v) + 3.5}
                    textAnchor="end"
                    className={base.axisText}
                  >
                    {log ? (
                      <>
                        10
                        <tspan dy={-5} fontSize={8}>
                          {Math.round(Math.log10(v))}
                        </tspan>
                      </>
                    ) : (
                      formatValue(v)
                    )}
                  </text>
                </g>
              ))}
              {xTicks.map((s) => (
                <text
                  key={s}
                  x={x(s)}
                  y={HEIGHT - 20}
                  textAnchor="middle"
                  className={base.axisText}
                >
                  {s === 0 ? "0" : formatSteps(s)}
                </text>
              ))}
              <text
                x={pad.left + plotW / 2}
                y={HEIGHT - 4}
                textAnchor="middle"
                className={base.axisText}
              >
                Training steps
              </text>

              {drawnMarkers.map((marker) => (
                <line
                  key={marker.step}
                  x1={x(marker.step)}
                  x2={x(marker.step)}
                  y1={pad.top}
                  y2={pad.top + plotH}
                  className={
                    marker.checkpoint ? styles.checkpointMarker : styles.evalMarker
                  }
                />
              ))}

              {showLr ? (
                <g>
                  {[0, 0.5, 1].map((share) => (
                    <text
                      key={share}
                      x={pad.left + plotW + 6}
                      y={yLr(lrMax * share) + 3.5}
                      className={base.axisText}
                    >
                      {formatRate(lrMax * share)}
                    </text>
                  ))}
                  <text
                    x={0}
                    y={0}
                    className={base.axisText}
                    transform={`translate(${width - 4} ${pad.top + plotH / 2}) rotate(90)`}
                    textAnchor="middle"
                  >
                    Learning rate
                  </text>
                  <path
                    d={built.lr
                      .map(
                        (v, i) =>
                          `${i ? "L" : "M"}${x(built.steps[i]!).toFixed(1)},${yLr(v).toFixed(1)}`,
                      )
                      .join("")}
                    fill="none"
                    stroke={LR_COLOUR}
                    strokeWidth={1.2}
                  />
                  <path
                    d={plannedLr
                      .map(
                        (p, i) =>
                          `${i ? "L" : "M"}${x(p.step).toFixed(1)},${yLr(p.value).toFixed(1)}`,
                      )
                      .join("")}
                    fill="none"
                    stroke={LR_COLOUR}
                    strokeWidth={1}
                    strokeDasharray="2 3"
                    opacity={0.6}
                  />
                </g>
              ) : null}

              {visible.map((curve) => {
                const raw = built.raw.get(curve.key) ?? [];
                const smooth = smoothed.get(curve.key) ?? [];
                if (curve.dashed) {
                  return (
                    <path
                      key={curve.key}
                      d={`M${pad.left},${y(raw[0] ?? curve.end).toFixed(1)}H${pad.left + plotW}`}
                      fill="none"
                      stroke={curve.colour}
                      strokeWidth={1.4}
                      strokeDasharray="5 4"
                    />
                  );
                }
                return (
                  <g key={curve.key}>
                    {smoothing > 0 ? (
                      <path
                        d={path(raw)}
                        fill="none"
                        stroke={curve.colour}
                        strokeWidth={1}
                        strokeOpacity={0.25}
                        strokeLinejoin="round"
                      />
                    ) : null}
                    <path
                      d={path(smooth)}
                      fill="none"
                      stroke={curve.colour}
                      strokeWidth={1.7}
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}

              <line
                x1={x(head)}
                x2={x(head)}
                y1={pad.top}
                y2={pad.top + plotH}
                className={base.stepLine}
              />
              {visible
                .filter((curve) => !curve.dashed)
                .map((curve) => {
                  const cx = x(head);
                  const cy = y(headValue(curve));
                  return (
                    <g key={curve.key} className={styles.head}>
                      {running ? (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={3}
                          fill={curve.colour}
                          className={styles.pulse}
                        />
                      ) : null}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={3}
                        fill={curve.colour}
                        stroke="#ffffff"
                        strokeWidth={1}
                      />
                    </g>
                  );
                })}

              {hovered !== undefined ? (
                <g>
                  <line
                    x1={x(hovered)}
                    x2={x(hovered)}
                    y1={pad.top}
                    y2={pad.top + plotH}
                    className={base.hoverLine}
                  />
                  {hoverIndex !== undefined
                    ? visible
                        .filter((curve) => !curve.dashed)
                        .map((curve) => (
                          <circle
                            key={curve.key}
                            cx={x(built.steps[hoverIndex]!)}
                            cy={y(smoothed.get(curve.key)?.[hoverIndex] ?? 0)}
                            r={2.5}
                            fill="#ffffff"
                            stroke={curve.colour}
                            strokeWidth={1.4}
                          />
                        ))
                    : null}
                </g>
              ) : null}
            </svg>

            {hovered !== undefined && hoverIndex !== undefined ? (
              <div
                className={styles.tip}
                style={{ left: tipLeft, width: tipWidth }}
                role="status"
              >
                <strong>Step {number(Math.round(hovered))}</strong>
                <span className={styles.tipMuted}>
                  {head - hovered < 0.5
                    ? "current step"
                    : approxAgo((head - hovered) / (run.stepsPerSecond || 1))}
                </span>
                {visible.map((curve) => {
                  const raw = built.raw.get(curve.key)?.[hoverIndex];
                  const smooth = smoothed.get(curve.key)?.[hoverIndex];
                  return (
                    <span key={curve.key} className={styles.tipRow}>
                      <i style={{ background: curve.colour }} aria-hidden="true" />
                      <span className={styles.tipLabel}>{curve.label}</span>
                      <b>{formatValue(smooth ?? Number.NaN)}</b>
                      {!curve.dashed && smoothing > 0 && raw !== undefined ? (
                        <span className={styles.tipMuted}>({formatValue(raw)})</span>
                      ) : null}
                    </span>
                  );
                })}
                {showLr ? (
                  <span className={styles.tipRow}>
                    <i style={{ background: LR_COLOUR }} aria-hidden="true" />
                    <span className={styles.tipLabel}>Learning rate</span>
                    <b>{formatRate(learningRateAt(run, hovered))}</b>
                  </span>
                ) : null}
                {hoverMarkers.map((marker) => (
                  <span key={marker.step} className={styles.tipMarker}>
                    {marker.evaluation && marker.checkpoint
                      ? "Evaluation completed · checkpoint written"
                      : marker.evaluation
                        ? "Evaluation completed"
                        : "Checkpoint written"}
                  </span>
                ))}
                {smoothing > 0 ? (
                  <span className={styles.tipMuted}>smoothed (raw)</span>
                ) : null}
              </div>
            ) : null}
          </div>

          <ul className={`${base.legend} ${styles.legend}`} aria-label="Series">
            {tab.curves.map((curve) => (
              <li key={curve.key}>
                <button
                  type="button"
                  aria-pressed={!hidden.has(curve.key)}
                  onClick={() =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (!next.delete(curve.key)) next.add(curve.key);
                      return next;
                    })
                  }
                >
                  <i
                    style={{
                      background: curve.dashed ? "transparent" : curve.colour,
                      borderColor: curve.colour,
                    }}
                    data-dashed={curve.dashed || undefined}
                    aria-hidden="true"
                  />
                  <span>{curve.label}</span>
                  <span className={styles.readout}>{formatValue(headValue(curve))}</span>
                </button>
              </li>
            ))}
            <li className={styles.markerKey} aria-hidden="true">
              <span>
                <i data-kind="eval" /> Eval
              </span>
              <span>
                <i data-kind="checkpoint" /> Checkpoint
              </span>
            </li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
