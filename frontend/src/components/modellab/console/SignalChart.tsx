"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import css from "./RunConsole.module.css";

export interface ChartPoint {
  readonly step: number;
  readonly value: number;
}

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  /** A colour token, e.g. `var(--series-1)`. */
  readonly colour: string;
  readonly points: readonly ChartPoint[];
  /** Draw the raw trace faintly under an exponential moving average. */
  readonly smooth?: boolean;
  readonly dashed?: boolean;
}

export interface ChartMarker {
  readonly id: string;
  readonly step: number;
  readonly severity: "warn" | "error";
  readonly label: string;
}

export interface SignalChartProps {
  readonly title: string;
  readonly unit?: string;
  readonly domain: readonly [number, number];
  readonly series: readonly ChartSeries[];
  /** Series share one x array and are drawn as stacked areas (a time breakdown). */
  readonly stacked?: boolean;
  readonly log?: boolean;
  readonly threshold?: { readonly value: number; readonly label: string };
  readonly markers?: readonly ChartMarker[];
  readonly checkpoints?: readonly number[];
  /** The run's current (fractional) step, drawn as the live edge. */
  readonly head?: number;
  readonly hover: number | null;
  readonly onHover: (step: number | null) => void;
  readonly height: number;
  readonly format: (value: number) => string;
}

const MARGIN = { top: 10, right: 14, bottom: 22, left: 52 };

/** TensorBoard's debiased exponential moving average. */
function ema(values: readonly number[], weight: number): number[] {
  const out: number[] = [];
  let last = 0;
  values.forEach((value, index) => {
    last = last * weight + (1 - weight) * value;
    out.push(last / (1 - Math.pow(weight, index + 1)));
  });
  return out;
}

/** Up to `count` round tick values across [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => span / m <= count) ??
    magnitude * 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

/**
 * Ticks for a log axis given its range in log10 units: 1, 2 and 5 times each decade, thinned
 * to the ones in range, so labels read 0.5 · 1 · 2 rather than 1.259 · 1.585.
 */
function logTicks(lo: number, hi: number): number[] {
  // Less than a decade in view: round values in linear space, placed on the log scale.
  if (hi - lo < 1) {
    const low = Math.pow(10, lo);
    const high = Math.pow(10, hi);
    return niceTicks(low, high, 4).filter(
      (value) => value > 0 && value >= low && value <= high,
    );
  }
  const ticks: number[] = [];
  for (let decade = Math.floor(lo); decade <= Math.ceil(hi); decade += 1) {
    for (const m of [1, 2, 5]) {
      const value = m * Math.pow(10, decade);
      const at = Math.log10(value);
      if (at >= lo && at <= hi) ticks.push(value);
    }
  }
  // Too many decades for 1-2-5: keep the powers of ten.
  // (Math.log10 is inexact: log10(1000) is 2.9999999999999996, hence the tolerance.)
  const decade = (value: number) =>
    Math.abs(Math.log10(value) - Math.round(Math.log10(value))) < 1e-9;
  return ticks.length > 6 ? ticks.filter(decade) : ticks;
}

export function formatStep(step: number): string {
  if (step >= 10000) return `${(step / 1000).toFixed(step >= 100000 ? 0 : 1)}K`;
  if (step >= 1000) return `${(step / 1000).toFixed(2)}K`;
  return String(Math.round(step));
}

function nearest(points: readonly ChartPoint[], step: number): ChartPoint | undefined {
  if (points.length === 0) return undefined;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.step < step) lo = mid + 1;
    else hi = mid;
  }
  const after = points[lo]!;
  const before = points[Math.max(0, lo - 1)]!;
  return Math.abs(before.step - step) <= Math.abs(after.step - step) ? before : after;
}

export function SignalChart({
  title,
  unit,
  domain,
  series,
  stacked = false,
  log = false,
  threshold,
  markers = [],
  checkpoints = [],
  head,
  hover,
  onHover,
  height,
  format,
}: SignalChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const [x0, x1] = domain;
  const x = (step: number) => MARGIN.left + ((step - x0) / Math.max(1e-9, x1 - x0)) * plotW;

  // Stacked series are accumulated in drawing order so each area sits on the previous one.
  const layers = useMemo(() => {
    if (!stacked) return series.map((item) => item.points.map((point) => point.value));
    const totals = new Array<number>(series[0]?.points.length ?? 0).fill(0);
    return series.map((item) =>
      item.points.map((point, index) => {
        totals[index] = (totals[index] ?? 0) + point.value;
        return totals[index]!;
      }),
    );
  }, [series, stacked]);

  const [yMin, yMax] = useMemo(() => {
    const values = layers
      .flat()
      .filter((value) => Number.isFinite(value) && (!log || value > 0));
    if (threshold) values.push(threshold.value);
    if (values.length === 0) return [0, 1];
    let lo = stacked ? 0 : Math.min(...values);
    let hi = Math.max(...values);
    if (log) {
      lo = Math.log10(lo);
      hi = Math.log10(hi);
      const pad = Math.max(0.04, (hi - lo) * 0.08);
      return [lo - pad, hi + pad];
    }
    const pad = Math.max(Math.abs(hi) * 1e-3, (hi - lo) * 0.1);
    return [stacked ? 0 : lo - pad, hi + pad];
  }, [layers, log, stacked, threshold]);

  const y = (value: number) => {
    const v = log ? Math.log10(Math.max(1e-12, value)) : value;
    return MARGIN.top + (1 - (v - yMin) / Math.max(1e-12, yMax - yMin)) * plotH;
  };

  const path = (steps: readonly number[], values: readonly number[]) => {
    let d = "";
    let pen = false;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(steps[index]!).toFixed(1)} ${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const yTicks = log ? logTicks(yMin, yMax) : niceTicks(yMin, yMax, 4);
  const xTicks = niceTicks(x0, x1, Math.max(3, Math.round(plotW / 140)));

  const readoutStep = hover ?? head;
  const readout =
    readoutStep === undefined
      ? []
      : series.map((item) => ({
          item,
          point: nearest(item.points, readoutStep),
        }));

  const handle = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - bounds.left) / bounds.width) * width;
    if (px < MARGIN.left || px > width - MARGIN.right) {
      onHover(null);
      return;
    }
    onHover(x0 + ((px - MARGIN.left) / plotW) * (x1 - x0));
  };

  const latest = series[0]?.points.at(-1);

  return (
    <figure className={css.chart}>
      <figcaption className={css.chartHead}>
        <span className={css.chartTitle}>
          {title}
          {unit ? <small> · {unit}</small> : null}
        </span>
        <span className={css.readout} aria-live="off">
          {readoutStep !== undefined ? (
            <span className={css.readoutStep}>step {formatStep(readoutStep)}</span>
          ) : null}
          {readout.map(({ item, point }) =>
            point ? (
              <span key={item.key} className={css.readoutItem}>
                <i style={{ background: item.colour }} aria-hidden="true" />
                {item.label}
                <b>{format(point.value)}</b>
              </span>
            ) : null,
          )}
        </span>
      </figcaption>
      <div ref={host} className={css.chartHost}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title}${latest ? `, latest ${format(latest.value)} at step ${Math.round(latest.step)}` : ""}`}
          onPointerMove={handle}
          onPointerLeave={() => onHover(null)}
        >
          {/* Grid and axes */}
          {yTicks.map((value) => (
            <g key={`y${value}`}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(value)}
                y2={y(value)}
                className={css.grid}
              />
              <text x={MARGIN.left - 8} y={y(value)} className={css.axisY}>
                {format(value)}
              </text>
            </g>
          ))}
          {xTicks.map((value) => (
            <text key={`x${value}`} x={x(value)} y={height - 6} className={css.axisX}>
              {formatStep(value)}
            </text>
          ))}
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={MARGIN.top + plotH}
            y2={MARGIN.top + plotH}
            className={css.axis}
          />

          {/* Checkpoint writes along the axis */}
          {checkpoints
            .filter((step) => step >= x0 && step <= x1)
            .map((step) => (
              <line
                key={`c${step}`}
                x1={x(step)}
                x2={x(step)}
                y1={MARGIN.top + plotH}
                y2={MARGIN.top + plotH - 6}
                className={css.checkpointTick}
              />
            ))}

          {/* Incident onsets */}
          {markers
            .filter((marker) => marker.step >= x0 && marker.step <= x1)
            .map((marker) => (
              <g key={marker.id} data-severity={marker.severity} className={css.marker}>
                <line
                  x1={x(marker.step)}
                  x2={x(marker.step)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + plotH}
                />
                <path
                  d={`M${x(marker.step) - 3.5} ${MARGIN.top}L${x(marker.step) + 3.5} ${MARGIN.top}L${x(marker.step)} ${MARGIN.top + 5}Z`}
                />
                <title>{marker.label}</title>
              </g>
            ))}

          {threshold ? (
            <g className={css.threshold}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(threshold.value)}
                y2={y(threshold.value)}
              />
              <text x={width - MARGIN.right - 4} y={y(threshold.value) - 4}>
                {threshold.label}
              </text>
            </g>
          ) : null}

          {/* Data */}
          {series.map((item, index) => {
            const steps = item.points.map((point) => point.step);
            const values = layers[index]!;
            if (stacked) {
              const below = index === 0 ? steps.map(() => 0) : layers[index - 1]!;
              const top = path(steps, values);
              const back = [...steps]
                .map((step, i) => ({ step, v: below[i]! }))
                .reverse()
                .map((point) => `L${x(point.step).toFixed(1)} ${y(point.v).toFixed(1)}`)
                .join("");
              return (
                <g key={item.key}>
                  <path
                    d={`${top}${back}Z`}
                    className={css.area}
                    style={{ fill: item.colour }}
                  />
                  <path d={top} className={css.stackLine} style={{ stroke: item.colour }} />
                </g>
              );
            }
            const smoothed = item.smooth ? ema(values, 0.85) : undefined;
            return (
              <g key={item.key}>
                <path
                  d={path(steps, values)}
                  className={item.smooth ? css.raw : css.line}
                  data-dashed={item.dashed || undefined}
                  style={{ stroke: item.colour }}
                />
                {smoothed ? (
                  <path
                    d={path(steps, smoothed)}
                    className={css.line}
                    style={{ stroke: item.colour }}
                  />
                ) : null}
              </g>
            );
          })}

          {/* Live edge */}
          {head !== undefined && head >= x0 && head <= x1 ? (
            <line
              x1={x(head)}
              x2={x(head)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              className={css.head}
            />
          ) : null}

          {/* Hover crosshair, shared across the stacked charts */}
          {hover !== null && hover >= x0 && hover <= x1 ? (
            <g className={css.crosshair}>
              <line x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={MARGIN.top + plotH} />
              {!stacked &&
                readout.map(({ item, point }) =>
                  point && Number.isFinite(point.value) ? (
                    <circle
                      key={item.key}
                      cx={x(point.step)}
                      cy={y(point.value)}
                      r={3}
                      style={{ fill: item.colour }}
                    />
                  ) : null,
                )}
            </g>
          ) : null}
        </svg>
      </div>
    </figure>
  );
}
