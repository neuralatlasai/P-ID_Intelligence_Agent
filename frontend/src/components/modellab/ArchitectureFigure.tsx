"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { ArchBox, ArchitectureSpec, Symbol } from "@/lib/modellab/architecture";

import css from "./ArchitectureFigure.module.css";

/*
 * A stage's architecture drawn the way a systems diagram is drawn: ink boxes on a dotted
 * field, one thin ink rule each, a title and a monospace second line, orthogonal connectors
 * with arrowheads in execution order. One accent path follows a single reference sample.
 *
 * Layout is computed here in a fixed 1200-unit coordinate space, so every connector meets a
 * box edge exactly; the SVG scales to its container and scrolls horizontally when narrow.
 */

const W = 1200;
const BOX_H = 56;
const GAP = 14;
const COL_W = 252;
const LEFT_X = 16;
const RIGHT_X = W - 16 - COL_W;
const CENTER_X = 346;
const CENTER_W = W - 2 * CENTER_X;
const LEFT_BUS = LEFT_X + COL_W + 39;
const RIGHT_BUS = RIGHT_X - 39;
/** Rows inside the model are further apart than column boxes: their gaps carry fan-in wiring. */
const ROW_GAP = 34;
const TOP = 46;
const CHAIN_W = 206;
const CHAIN_GAP = 46;
const AGG_W = 290;

interface Placed {
  readonly box: ArchBox;
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

const cx = (p: Placed) => p.x + p.w / 2;
const cy = (p: Placed) => p.y + BOX_H / 2;

function column(boxes: readonly ArchBox[], x: number, top: number): Placed[] {
  return boxes.map((box, index) => ({ box, x, y: top + index * (BOX_H + GAP), w: COL_W }));
}

function layout(spec: ArchitectureSpec) {
  const leftH = spec.sources.length * (BOX_H + GAP) - GAP;
  const rightH = spec.heads.length * (BOX_H + GAP) - GAP;
  const containerH = 56 + spec.model.length * (BOX_H + ROW_GAP) - ROW_GAP + 18;
  const band = Math.max(leftH, rightH, containerH);

  const left = column(spec.sources, LEFT_X, TOP + (band - leftH) / 2);
  const right = column(spec.heads, RIGHT_X, TOP + (band - rightH) / 2);
  const containerY = TOP + (band - containerH) / 2;
  const innerX = CENTER_X + 18;
  const innerW = CENTER_W - 36;
  const rows: Placed[][] = spec.model.map((row, r) => {
    const w = (innerW - (row.length - 1) * 12) / row.length;
    return row.map((box, i) => ({
      box,
      x: innerX + i * (w + 12),
      y: containerY + 56 + r * (BOX_H + ROW_GAP),
      w,
    }));
  });
  const midY = containerY + containerH / 2;
  // Data enters at the first row and leaves from the last: the wires say where, not a midpoint.
  const entryY = cy(rows[0]![0]!);
  const exitY = cy(rows.at(-1)![0]!);
  const innerRight = innerX + innerW;

  const aggY = TOP + band + 58;
  const aggregate: Placed = {
    box: spec.aggregate,
    x: W / 2 - AGG_W / 2,
    y: aggY,
    w: AGG_W,
  };
  const chainY = aggY + BOX_H + 60;
  const chainTotal = spec.chain.length * CHAIN_W + (spec.chain.length - 1) * CHAIN_GAP;
  const chain: Placed[] = spec.chain.map((box, i) => ({
    box,
    x: W / 2 - chainTotal / 2 + i * (CHAIN_W + CHAIN_GAP),
    y: chainY,
    w: CHAIN_W,
  }));
  const height = chainY + BOX_H + 30;

  return {
    left,
    right,
    rows,
    containerY,
    containerH,
    midY,
    entryY,
    exitY,
    innerX,
    innerRight,
    aggregate,
    chain,
    height,
  };
}

/** The y of the bus in the gap between model row r and row r + 1. */
function gapY(geo: Layout, r: number): number {
  return geo.rows[r]![0]!.y + BOX_H + ROW_GAP / 2;
}

/**
 * Wires between consecutive model rows. Each box of the upper row drops into the gap, a bus
 * joins them, and each box of the lower row takes an arrow from it — so parallel boxes fan in
 * and out, and a single box connects straight through. No arrow is drawn between parallel
 * boxes, because nothing flows between them.
 */
function rowWires(geo: Layout): { readonly d: string; readonly arrow: boolean }[] {
  const wires: { d: string; arrow: boolean }[] = [];
  geo.rows.slice(1).forEach((lower, index) => {
    const upper = geo.rows[index]!;
    const y = gapY(geo, index);
    const xs = [...upper.map(cx), ...lower.map(cx)];
    if (
      upper.length === 1 &&
      lower.length === 1 &&
      Math.abs(cx(upper[0]!) - cx(lower[0]!)) < 1
    ) {
      wires.push({
        d: `M${cx(upper[0]!)},${upper[0]!.y + BOX_H} V${lower[0]!.y}`,
        arrow: true,
      });
      return;
    }
    for (const p of upper)
      wires.push({ d: `M${cx(p)},${p.y + BOX_H} V${y}`, arrow: false });
    wires.push({ d: `M${Math.min(...xs)},${y} H${Math.max(...xs)}`, arrow: false });
    for (const p of lower) wires.push({ d: `M${cx(p)},${y} V${p.y}`, arrow: true });
  });
  return wires;
}

type Layout = ReturnType<typeof layout>;

/** Orthogonal polyline through points, inserting an elbow wherever both axes change. */
function orthogonal(points: readonly (readonly [number, number])[]): string {
  const out: [number, number][] = [];
  for (const [x, y] of points) {
    const last = out.at(-1);
    if (last && last[0] !== x && last[1] !== y) out.push([x, last[1]]);
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  return out
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
}

/**
 * The reference path. It travels only on drawn wires — source stub, left bus, entry, the
 * gap buses between model rows, exit, right bus — and passes behind the boxes it visits.
 */
function tracePath(spec: ArchitectureSpec, geo: Layout): string {
  const points: [number, number][] = [];
  const source = geo.left.find((p) => spec.trace.includes(p.box.id)) ?? geo.left[0];
  if (source) {
    points.push(
      [source.x + source.w, cy(source)],
      [LEFT_BUS, cy(source)],
      [LEFT_BUS, geo.entryY],
    );
    points.push([geo.innerX, geo.entryY]);
  }
  geo.rows.forEach((row, r) => {
    const p = row.find((item) => spec.trace.includes(item.box.id)) ?? row[0]!;
    points.push([cx(p), cy(p)]);
    if (r < geo.rows.length - 1) points.push([cx(p), gapY(geo, r)]);
  });
  const last = geo.rows.at(-1)!;
  const lastTraced = last.find((item) => spec.trace.includes(item.box.id)) ?? last[0]!;
  points.push(
    [cx(lastTraced), geo.exitY],
    [geo.innerRight, geo.exitY],
    [RIGHT_BUS, geo.exitY],
  );
  const head = geo.right.find((p) => spec.trace.includes(p.box.id)) ?? geo.right[0];
  if (head) {
    points.push([RIGHT_BUS, cy(head)], [head.x + 18, cy(head)], [RIGHT_BUS, cy(head)]);
  }
  const agg = geo.aggregate;
  points.push([RIGHT_BUS, cy(agg)], [agg.x + agg.w, cy(agg)], [cx(agg), cy(agg)]);
  const first = geo.chain[0];
  if (first) {
    points.push(
      [cx(agg), agg.y + BOX_H + 30],
      [cx(first), agg.y + BOX_H + 30],
      [cx(first), cy(first)],
    );
    for (const p of geo.chain.slice(1)) points.push([cx(p), cy(p)]);
  }
  return orthogonal(points);
}

const ICON: Record<Symbol, string> = {
  sheet: "M3 2h12v14H3z M3 12h12 M5.5 5.5l3.5 2-3.5 2z M12.5 5.5L9 7.5l3.5 2z",
  graph:
    "M4 14a1.8 1.8 0 1 0 0-.1z M14 14a1.8 1.8 0 1 0 0-.1z M9 4.2a1.8 1.8 0 1 0 0-.1z M5.5 12.6l2.4-6.8 M12.5 12.6l-2.4-6.8 M5.8 14h6.4",
  camera: "M2 6h3l1.5-2h5L13 6h3v9H2z M9 13.3a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z",
  cube: "M9 2l6 3.5v7L9 16l-6-3.5v-7z M9 9l6-3.5 M9 9v7 M9 9L3 5.5",
  wave: "M1 9h3l2-5 3 10 3-8 2 3h3",
  document: "M4 2h7l4 4v10H4z M11 2v4h4 M6.5 10h6 M6.5 13h6",
  chat: "M2 3h14v9H8l-4 3v-3H2z M5 6.5h8 M5 9h5",
  encoder: "M3 3h4v4H3z M11 3h4v4h-4z M3 11h4v4H3z M11 11h4v4h-4z",
  project: "M2 4h14l-4 10H6z M9 4v10",
  layers: "M9 2l7 3.5-7 3.5-7-3.5z M2 9l7 3.5 7-3.5 M2 12.5l7 3.5 7-3.5",
  head: "M2 9h5 M7 9l8-5 M7 9h8 M7 9l8 5",
  sigma: "M14 3H4l5 6-5 6h10",
  gradient: "M2 3h14L9 15z",
  optimizer: "M3 5h12 M3 9h12 M3 13h12 M6 3.5v3 M12 7.5v3 M8 11.5v3",
  checkpoint:
    "M3 4c0-1.4 2.7-2 6-2s6 .6 6 2v10c0 1.4-2.7 2-6 2s-6-.6-6-2z M3 4c0 1.4 2.7 2 6 2s6-.6 6-2 M3 9c0 1.4 2.7 2 6 2s6-.6 6-2",
  verifier: "M9 2l6 2.5v4.5c0 3.5-2.6 6-6 7-3.4-1-6-3.5-6-7V4.5z M6 9l2 2 4-4",
  sampler: "M2 9h5 M7 9l8-5 M7 9h8 M7 9l8 5 M15 4h1 M15 9h1 M15 14h1",
  teacher: "M9 2l7 3.5-7 3.5-7-3.5z M2 9l7 3.5 7-3.5 M2 12.5l7 3.5 7-3.5",
  student: "M9 5l5 2.5-5 2.5-5-2.5z M4 10.5l5 2.5 5-2.5",
  export: "M3 8v8h12V8 M9 2v10 M5.5 5.5L9 2l3.5 3.5",
};

function Box({ p, traced }: { readonly p: Placed; readonly traced: boolean }) {
  const { box } = p;
  const titleMax = Math.floor((p.w - 48) / 6.5);
  const detailMax = Math.floor((p.w - 48) / 6.3);
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  return (
    <g
      className={css.box}
      data-absent={box.absent || undefined}
      data-traced={traced || undefined}
      transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
    >
      <title>{`${box.title} — ${box.detail}${box.absent ? " (not connected)" : ""}${box.frozen ? " (frozen weights)" : ""}`}</title>
      <rect width={p.w} height={BOX_H} rx={3} />
      {box.frozen && (
        <path className={css.frozen} d={`M5 7V${BOX_H - 7} M8 7V${BOX_H - 7}`} />
      )}
      <path className={css.icon} d={ICON[box.symbol]} transform="translate(12 19)" />
      <text className={css.title} x={40} y={24}>
        {clip(box.title, titleMax)}
      </text>
      <text className={css.detail} x={40} y={41}>
        {clip(box.detail, detailMax)}
      </text>
    </g>
  );
}

function subscribeMotion(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const prefersReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ArchitectureFigure({
  spec,
  running,
  sampleTag,
  stepSeconds,
}: {
  readonly spec: ArchitectureSpec;
  readonly running: boolean;
  readonly sampleTag: string | undefined;
  /** Wall-clock seconds per optimiser step; the reference path runs at a readable pace. */
  readonly stepSeconds: number;
}) {
  const geo = useMemo(() => layout(spec), [spec]);
  const path = useMemo(() => tracePath(spec, geo), [spec, geo]);
  const traced = useMemo(() => new Set(spec.trace), [spec]);
  const reduced = useSyncExternalStore(subscribeMotion, prefersReduced, () => true);
  const [held, setHeld] = useState(false);
  const [replays, setReplays] = useState(0);
  const [inView, setInView] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { threshold: 0.05 },
    );
    if (figure.current) observer.observe(figure.current);
    return () => observer.disconnect();
  }, []);

  const moving = running && !held && inView && !reduced && sampleTag !== undefined;
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    if (moving) element.unpauseAnimations();
    else element.pauseAnimations();
  }, [moving, replays]);

  const busLeft = [...geo.left.map(cy), geo.entryY];
  const busRight = [...geo.right.map(cy), geo.exitY, cy(geo.aggregate)];
  const wires = useMemo(() => rowWires(geo), [geo]);
  const agg = geo.aggregate;
  const first = geo.chain[0];
  const duration = 7;

  return (
    <figure
      ref={figure}
      className={css.figure}
      aria-label={spec.figure}
      data-motion={moving}
    >
      <header className={css.head}>
        <div>
          <span className={css.caption}>{spec.figure}</span>
          <h3>{spec.heading}</h3>
          <p>{spec.description}</p>
        </div>
        <div className={css.actions}>
          <button
            type="button"
            onClick={() => {
              setReplays((value) => value + 1);
              setHeld(false);
            }}
            disabled={reduced || !sampleTag}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.6-3.7 M13 2.5v3h-3" />
            </svg>
            Replay
          </button>
          <button
            type="button"
            aria-pressed={!held}
            onClick={() => setHeld((value) => !value)}
            disabled={reduced || !sampleTag}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {held ? <path d="M5 3l8 5-8 5z" /> : <path d="M5 3v10 M11 3v10" />}
            </svg>
            {held ? "Play" : "Pause"}
          </button>
        </div>
      </header>

      <ul className={css.legend} aria-label="Figure legend">
        <li>
          <i data-kind="solid" aria-hidden="true" />
          Configured
        </li>
        <li>
          <i data-kind="dashed" aria-hidden="true" />
          Not connected or disabled
        </li>
        <li>
          <i data-kind="frozen" aria-hidden="true" />
          Frozen weights
        </li>
        <li>
          <i data-kind="trace" aria-hidden="true" />
          Reference path{sampleTag ? ` · ${sampleTag}` : ""}
        </li>
      </ul>

      <div
        className={css.canvas}
        tabIndex={0}
        role="region"
        aria-label={`${spec.figure} diagram`}
      >
        <svg
          key={replays}
          ref={svg}
          className={css.svg}
          viewBox={`0 0 ${W} ${geo.height.toFixed(0)}`}
          role="img"
          aria-label={`${spec.heading} ${spec.sourcesTitle}: ${spec.sources.map((b) => b.title).join(", ")}. ${spec.modelTitle}: ${spec.model
            .flat()
            .map((b) => b.title)
            .join(
              ", ",
            )}. ${spec.headsTitle}: ${spec.heads.map((b) => b.title).join(", ")}. Then ${[spec.aggregate, ...spec.chain].map((b) => b.title).join(", ")}.`}
        >
          <defs>
            <pattern id="arch-dots" width="14" height="14" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.9" className={css.dot} />
            </pattern>
            <marker
              id="arch-arrow"
              viewBox="0 0 8 8"
              refX="7.5"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0 0.5L7.5 4 0 7.5" className={css.arrowHead} />
            </marker>
          </defs>
          <rect width={W} height={geo.height} fill="url(#arch-dots)" />

          <text className={css.columnTitle} x={LEFT_X} y={TOP - 16}>
            {spec.sourcesTitle.toUpperCase()}
          </text>
          <text className={css.columnTitle} x={RIGHT_X} y={TOP - 16}>
            {spec.headsTitle.toUpperCase()}
          </text>

          {/* connectors: sources → model */}
          <g className={css.wire}>
            {geo.left.map((p) => (
              <path key={p.box.id} d={`M${p.x + p.w},${cy(p)} H${LEFT_BUS}`} />
            ))}
            <path d={`M${LEFT_BUS},${Math.min(...busLeft)} V${Math.max(...busLeft)}`} />
            <path
              d={`M${LEFT_BUS},${geo.entryY} H${geo.innerX}`}
              markerEnd="url(#arch-arrow)"
            />

            {/* model → heads → aggregate */}
            <path d={`M${geo.innerRight},${geo.exitY} H${RIGHT_BUS}`} />
            <path d={`M${RIGHT_BUS},${Math.min(...busRight)} V${Math.max(...busRight)}`} />
            {geo.right.map((p) => (
              <path
                key={p.box.id}
                d={`M${RIGHT_BUS},${cy(p)} H${p.x}`}
                markerEnd="url(#arch-arrow)"
              />
            ))}
            <path
              d={`M${RIGHT_BUS},${cy(agg)} H${agg.x + agg.w}`}
              markerEnd="url(#arch-arrow)"
            />

            {/* aggregate → update chain */}
            {first && (
              <path
                d={`M${cx(agg)},${agg.y + BOX_H} V${agg.y + BOX_H + 30} H${cx(first)} V${first.y}`}
                markerEnd="url(#arch-arrow)"
              />
            )}
            {geo.chain.slice(1).map((p, i) => (
              <path
                key={p.box.id}
                d={`M${geo.chain[i]!.x + CHAIN_W},${cy(p)} H${p.x}`}
                markerEnd="url(#arch-arrow)"
              />
            ))}
          </g>

          <g
            className={css.container}
            transform={`translate(${CENTER_X} ${geo.containerY})`}
          >
            <rect width={CENTER_W} height={geo.containerH} rx={4} />
            <text className={css.containerTitle} x={CENTER_W / 2} y={24}>
              {spec.modelTitle}
            </text>
            <text className={css.containerDetail} x={CENTER_W / 2} y={40}>
              {spec.modelDetail}
            </text>
          </g>

          {/* Inside the model, drawn over the container: row to row, in execution order. */}
          <g className={css.wire}>
            {wires.map((wire) => (
              <path
                key={wire.d}
                d={wire.d}
                markerEnd={wire.arrow ? "url(#arch-arrow)" : undefined}
              />
            ))}
          </g>

          {/* The accent path runs under the boxes, so it shows on the wires and never over text. */}
          {sampleTag && <path className={css.trace} d={path} />}

          {[...geo.left, ...geo.rows.flat(), ...geo.right, geo.aggregate, ...geo.chain].map(
            (p) => (
              <Box key={p.box.id} p={p} traced={traced.has(p.box.id)} />
            ),
          )}

          {sampleTag && !reduced && (
            <circle r="5" className={css.packet} data-testid="reference-packet">
              <animateMotion
                dur={`${duration}s`}
                repeatCount="indefinite"
                path={path}
                calcMode="linear"
              />
            </circle>
          )}
        </svg>
      </div>

      <footer className={css.foot}>
        <span>
          {reduced
            ? "Reduced motion · static reference path"
            : held
              ? "Reference path held"
              : running
                ? `Reference path loops every ${duration} s · one optimiser step takes ${stepSeconds.toFixed(1)} s`
                : "Training paused · reference path frozen"}
        </span>
        <span>Specification of the configured model · not worker telemetry</span>
      </footer>
    </figure>
  );
}
