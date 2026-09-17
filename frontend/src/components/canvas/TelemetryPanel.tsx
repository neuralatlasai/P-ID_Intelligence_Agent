"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { AssetRecord, PlantRegister } from "@/lib/canvas/engineering";
import {
  SCAN_MS,
  telemetryFor,
  WINDOWS,
  type AlarmLevel,
  type Sample,
  type Telemetry,
  type Window,
} from "@/lib/canvas/telemetry";

import { SimulatedBadge } from "./AssetPanels";
import styles from "./TelemetryPanel.module.css";

/**
 * Live loop telemetry: an ISA-101 style trend beside a faceplate.
 *
 * The trend is drawn in greys; colour appears only where the process deviates — amber past
 * H or L, red past HH or LL — so an excursion is the first thing seen. The chart is measured
 * and drawn in CSS pixels rather than scaled from a viewBox, so its labels stay the size of
 * the text around them at any panel width.
 *
 * The clock advances one scan every five seconds while the tab is visible and the trend is
 * not paused; pausing freezes the window for reading, as a historian's trend does.
 */

const HEIGHT = 196;
const PAD = { left: 44, right: 64, top: 10, bottom: 24 };

const LEVEL_CLASS: Record<AlarmLevel, string | undefined> = {
  HH: styles.limitHigh,
  LL: styles.limitHigh,
  H: styles.limitMedium,
  L: styles.limitMedium,
};

function formatTime(t: number, window: Window): string {
  const date = new Date(t);
  if (window === "1W") {
    return date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit" });
  }
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function format(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function TelemetryPanel({
  asset,
  source,
  register,
  onAsk,
}: {
  readonly asset?: AssetRecord | undefined;
  readonly source?: AssetRecord | undefined;
  readonly register: PlantRegister;
  readonly onAsk: (question: string) => void;
}) {
  const measured = asset?.telemetry ? asset : source;
  const [window, setWindow] = useState<Window>("8H");
  const [now, setNow] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const [showSp, setShowSp] = useState(true);
  const [showOp, setShowOp] = useState(true);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, SCAN_MS);
    return () => clearInterval(timer);
  }, [paused]);

  const data = useMemo(
    () => (measured ? telemetryFor(measured, register, window, now) : undefined),
    [measured, register, window, now],
  );

  if (!measured || !data) {
    return (
      <section className={styles.panel} aria-label="Tag telemetry">
        <header className={styles.header}>
          <h2>Tag telemetry</h2>
          <SimulatedBadge />
        </header>
        <p className={styles.quiet}>
          Select an instrument, or a valve or vessel with a measuring instrument, to see its
          live trend.
        </p>
      </section>
    );
  }

  const alarmText = data.active
    ? `${data.active.level} alarm active (${data.active.priority} priority)`
    : "No active alarm";

  return (
    <section className={styles.panel} aria-label="Tag telemetry">
      <header className={styles.header}>
        <h2>Tag telemetry</h2>
        <SimulatedBadge />
        <span className={styles.live} data-paused={paused || undefined}>
          <i aria-hidden="true" />
          {paused ? "Paused" : `Live · ${SCAN_MS / 1000} s scan`}
        </span>
        <span className={styles.spacer} />
        <span
          className={styles.chip}
          data-state={data.quality === "Good" ? "ok" : "warn"}
          title="OPC UA status code of the latest value"
        >
          Quality: {data.quality.replace("_", " · ")}
        </span>
        <span
          className={styles.chip}
          data-state={data.health === "Good" ? "ok" : "warn"}
          title="NAMUR NE 107 device status"
        >
          NE 107: {data.health}
        </span>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.identity}>
          <strong>
            {data.tag} · {data.measurement}
          </strong>
          <small>
            {measured !== asset && asset
              ? `Measured by ${data.tag} for ${asset.tag} ${asset.name}`
              : measured.name}
            {data.loop ? ` · loop ${data.loop.id} → ${data.loop.valve}` : ""}
          </small>
        </div>
        <div className={styles.legend} role="group" aria-label="Trend pens">
          <span className={styles.pen} data-pen="pv">
            PV
          </span>
          {data.loop && (
            <>
              <button
                aria-pressed={showSp}
                onClick={() => setShowSp((v) => !v)}
                data-pen="sp"
              >
                SP
              </button>
              <button
                aria-pressed={showOp}
                onClick={() => setShowOp((v) => !v)}
                data-pen="op"
              >
                OP %
              </button>
            </>
          )}
        </div>
        <div className={styles.segmented} role="group" aria-label="Trend window">
          {(Object.keys(WINDOWS) as Window[]).map((key) => (
            <button key={key} aria-pressed={window === key} onClick={() => setWindow(key)}>
              {key}
            </button>
          ))}
        </div>
        <button
          className={styles.pause}
          aria-pressed={paused}
          onClick={() => {
            setPaused((v) => !v);
            setNow(Date.now());
          }}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div className={styles.body}>
        <Chart data={data} window={window} showSp={showSp} showOp={showOp} />
        <Faceplate data={data} />
      </div>

      <dl className={styles.stats}>
        {(
          [
            ["Min", format(data.stats.min, data.unit)],
            ["Max", format(data.stats.max, data.unit)],
            ["Mean", format(data.stats.mean, data.unit)],
            ["Std dev σ", format(data.stats.sigma, data.unit)],
            [
              "Rate",
              `${data.stats.ratePerMin >= 0 ? "+" : ""}${data.stats.ratePerMin.toFixed(3)} ${data.unit}/min`,
            ],
            ["Outside normal", `${(data.stats.outsideNormal * 100).toFixed(1)} %`],
            [
              "Alarm events",
              String(data.events.filter((e) => e.state === "ACTIVE").length),
            ],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className={styles.lower}>
        <div>
          <h3>Alarm configuration · ISA-18.2</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Limit</th>
                <th scope="col">Priority</th>
                <th scope="col">Deadband</th>
                <th scope="col">On-delay</th>
              </tr>
            </thead>
            <tbody>
              {data.limits.map((limit) => (
                <tr
                  key={limit.level}
                  data-active={data.active?.level === limit.level || undefined}
                >
                  <td>
                    <span className={`${styles.level} ${LEVEL_CLASS[limit.level]}`}>
                      {limit.level}
                    </span>
                  </td>
                  <td>{format(limit.value, data.unit)}</td>
                  <td>{limit.priority}</td>
                  <td>{format(limit.deadband, data.unit)}</td>
                  <td>{limit.onDelayS} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>
            Alarm journal · last {window}
            <span
              className={styles.journalState}
              data-active={Boolean(data.active) || undefined}
            >
              {alarmText}
            </span>
          </h3>
          {data.events.length ? (
            <ol className={styles.journal} tabIndex={0} aria-label="Alarm journal">
              {[...data.events]
                .reverse()
                .slice(0, 8)
                .map((event) => (
                  <li key={`${event.t}-${event.level}-${event.state}`}>
                    <time>
                      {new Date(event.t).toLocaleString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <span className={`${styles.level} ${LEVEL_CLASS[event.level]}`}>
                      {event.level}
                    </span>
                    <span>
                      {event.state === "ACTIVE" ? "Activated" : "Returned to normal"}
                    </span>
                    <b>{format(event.value, data.unit)}</b>
                  </li>
                ))}
            </ol>
          ) : (
            <p className={styles.quiet}>No alarm activated in this window.</p>
          )}
          <button
            className={styles.ask}
            onClick={() =>
              onAsk(
                `${data.tag} (${data.measurement}) over the last ${window}: PV ${format(data.current.pv, data.unit)}, mean ${format(data.stats.mean, data.unit)}, σ ${format(data.stats.sigma, data.unit)}, ${(data.stats.outsideNormal * 100).toFixed(1)} % of the window outside ${data.normal[0]}–${data.normal[1]} ${data.unit}, ${data.events.filter((e) => e.state === "ACTIVE").length} alarm activations, device status ${data.health}. Using the drawing, what upstream or downstream components could explain this behaviour, and what should be checked first?`,
              )
            }
          >
            Ask agent to diagnose this trend
          </button>
        </div>
      </div>
    </section>
  );
}

function Chart({
  data,
  window,
  showSp,
  showOp,
}: {
  readonly data: Telemetry;
  readonly window: Window;
  readonly showSp: boolean;
  readonly showOp: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { series, limits, normal, unit } = data;
  const hh = limits[0]!.value;
  const ll = limits[3]!.value;
  const values = series.map((s) => s.pv);
  const lo = Math.min(ll, ...values);
  const hi = Math.max(hh, ...values);
  const margin = (hi - lo) * 0.08;
  const yMin = lo - margin;
  const yMax = hi + margin;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = series[0]!.t;
  const t1 = series.at(-1)!.t;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const yOp = (v: number) => PAD.top + (1 - v / 100) * plotH;
  const line = (pick: (s: Sample) => number | undefined, scale: (v: number) => number) =>
    series
      .map((s, i) => {
        const v = pick(s);
        return v === undefined
          ? ""
          : `${i ? "L" : "M"}${x(s.t).toFixed(1)},${scale(v).toFixed(1)}`;
      })
      .join("");

  const h = limits[1]!.value;
  const l = limits[2]!.value;
  const ticks = 5;
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const hovered = hover === undefined ? undefined : series[hover];

  return (
    <div ref={host} className={styles.chart}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${data.tag} ${data.measurement} over the last ${window}. Current ${format(data.current.pv, unit)}. Normal ${normal[0]} to ${normal[1]}.`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left;
          if (px < PAD.left || px > width - PAD.right) return setHover(undefined);
          const ratio = (px - PAD.left) / plotW;
          setHover(Math.round(ratio * (series.length - 1)));
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <defs>
          <clipPath id={`above-${data.tag}`}>
            <rect x={PAD.left} y={0} width={plotW} height={Math.max(0, y(h))} />
          </clipPath>
          <clipPath id={`below-${data.tag}`}>
            <rect x={PAD.left} y={y(l)} width={plotW} height={Math.max(0, HEIGHT - y(l))} />
          </clipPath>
        </defs>

        <rect
          x={PAD.left}
          y={y(normal[1])}
          width={plotW}
          height={Math.max(0, y(normal[0]) - y(normal[1]))}
          className={styles.normal}
        />
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(v)}
              y2={y(v)}
              className={styles.grid}
            />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" className={styles.axis}>
              {Math.abs(yMax - yMin) >= 20 ? v.toFixed(0) : v.toFixed(1)}
            </text>
          </g>
        ))}
        {Array.from({ length: ticks }, (_, i) => t0 + ((t1 - t0) * i) / (ticks - 1)).map(
          (t, i) => (
            <text
              key={t}
              x={x(t)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}
              className={styles.axis}
            >
              {formatTime(t, window)}
            </text>
          ),
        )}

        {limits.map((limit) => (
          <g key={limit.level}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(limit.value)}
              y2={y(limit.value)}
              className={limit.priority === "High" ? styles.hhLine : styles.hLine}
            />
            <text
              x={width - PAD.right + 6}
              y={y(limit.value) + 3.5}
              className={limit.priority === "High" ? styles.hhText : styles.hText}
            >
              {limit.level} {limit.value}
            </text>
          </g>
        ))}

        {data.loop && showOp && <path d={line((s) => s.op, yOp)} className={styles.op} />}
        {data.loop && showSp && <path d={line((s) => s.sp, y)} className={styles.sp} />}
        <path d={line((s) => s.pv, y)} className={styles.pv} />
        <path
          d={line((s) => s.pv, y)}
          className={styles.pvAlarm}
          clipPath={`url(#above-${data.tag})`}
        />
        <path
          d={line((s) => s.pv, y)}
          className={styles.pvAlarm}
          clipPath={`url(#below-${data.tag})`}
        />
        {data.events
          .filter((e) => e.state === "ACTIVE")
          .map((e) => (
            <circle
              key={`${e.t}${e.level}`}
              cx={x(e.t)}
              cy={y(e.value)}
              r={3.5}
              className={e.priority === "High" ? styles.eventHigh : styles.eventMedium}
            />
          ))}
        <circle
          cx={x(data.current.t)}
          cy={y(data.current.pv)}
          r={3.5}
          className={styles.head}
        />

        {hovered && (
          <g>
            <line
              x1={x(hovered.t)}
              x2={x(hovered.t)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              className={styles.cursor}
            />
            <circle cx={x(hovered.t)} cy={y(hovered.pv)} r={3} className={styles.head} />
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className={styles.tooltip}
          style={{ left: Math.min(width - 170, Math.max(0, x(hovered.t) + 10)) }}
        >
          <time>
            {new Date(hovered.t).toLocaleString("en-GB", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
          <span>PV {format(hovered.pv, unit)}</span>
          {hovered.sp !== undefined && <span>SP {format(hovered.sp, unit)}</span>}
          {hovered.op !== undefined && <span>OP {hovered.op.toFixed(1)} %</span>}
          <span>Quality {data.quality === "Good" ? "Good" : data.quality}</span>
        </div>
      )}
    </div>
  );
}

/** Faceplate: PV, SP, OP, mode, loop current and an analogue bar with the limits marked. */
function Faceplate({ data }: { readonly data: Telemetry }) {
  const [rLo, rHi] = data.range;
  const pos = (v: number) =>
    `${Math.min(100, Math.max(0, ((v - rLo) / (rHi - rLo)) * 100))}%`;
  const state = data.active
    ? data.active.priority === "High"
      ? "high"
      : "medium"
    : undefined;
  return (
    <div className={styles.faceplate} data-alarm={state}>
      <div className={styles.pvBlock}>
        <small>PV</small>
        <strong>
          {data.current.pv.toFixed(Math.abs(data.current.pv) >= 100 ? 1 : 2)}
          <span>{data.unit}</span>
        </strong>
        {data.active && <em>{data.active.level}</em>}
      </div>
      <div className={styles.bar} aria-hidden="true">
        <i
          style={{
            bottom: pos(data.normal[0]),
            height: `calc(${pos(data.normal[1])} - ${pos(data.normal[0])})`,
          }}
          className={styles.barNormal}
        />
        {data.limits.map((limit) => (
          <b
            key={limit.level}
            style={{ bottom: pos(limit.value) }}
            data-priority={limit.priority}
          />
        ))}
        <u style={{ bottom: pos(data.current.pv) }} />
      </div>
      <dl>
        {data.loop && (
          <>
            <div>
              <dt>SP</dt>
              <dd>{data.current.sp?.toFixed(2)}</dd>
            </div>
            <div>
              <dt>OP</dt>
              <dd>{data.current.op?.toFixed(1)} %</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{data.loop.mode}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Loop</dt>
          <dd title={`NAMUR NE 43 signal: ${data.signal}`}>
            {data.milliamps.toFixed(2)} mA
          </dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>
            {rLo}–{rHi}
          </dd>
        </div>
      </dl>
    </div>
  );
}
