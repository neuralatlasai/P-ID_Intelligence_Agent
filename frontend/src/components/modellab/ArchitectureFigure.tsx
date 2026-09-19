"use client";

import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ArchBox, ArchitectureSpec, Symbol } from "@/lib/modellab/architecture";
import { evalEvery } from "@/lib/modellab/evaluation";
import { clamp } from "@/lib/modellab/noise";
import { curveAt, stepAt } from "@/lib/modellab/run";
import { frameAt, MAX_GRAD_NORM, type StepFrame } from "@/lib/modellab/telemetry";
import { scaleColour } from "@/lib/series";

import css from "./ArchitectureFigure.module.css";
import { PHASE_COLOUR } from "./console/StepAnatomy";
import { useFrameClock } from "./console/useFrameClock";
import { useRunClock } from "./flow/RunClockContext";
import {
  accumulation,
  completionFinish,
  completionsDone,
  formatSeconds,
  gradMagnitude,
  groupAdvantages,
  groupRewards,
  liveTerms,
  momentOf,
  stepSegments,
  tokenLosses,
  transferPair,
  type GradMagnitude,
  type LiveTerms,
  type Segment,
  type TransferPair,
} from "./flow/stepFlow";

/*
 * A stage's architecture drawn the way a systems diagram is drawn — ink boxes on a dotted
 * field, orthogonal connectors in execution order — and driven by the run itself. The step
 * that is executing right now is located inside its phases (the same micro-batch layout the
 * run console's step anatomy uses), and the diagram shows that phase: activations travelling
 * forward, weighted terms converging into the aggregate, gradients travelling back and
 * stopping at frozen weights, the exposed reduce-scatter, the optimizer step.
 *
 * Layout is computed in a fixed coordinate space so every connector meets a box edge exactly;
 * the SVG scales to its container and scrolls horizontally when narrow. Geometry and the box
 * layer are memoised; only the overlay of moving marks re-renders with the frame clock.
 */

const W = 1264;
/** Centre line of the aggregate and the update chain (the model container's centre). */
const MID = 600;
const BOX_H = 56;
const GAP = 14;
const COL_W = 252;
const LEFT_X = 16;
const RIGHT_X = 932;
const CENTER_X = 346;
const CENTER_W = 2 * (MID - CENTER_X);
const LEFT_BUS = LEFT_X + COL_W + 39;
const RIGHT_BUS = RIGHT_X - 39;
/** Rows inside the model are further apart than column boxes: their gaps carry fan-in wiring. */
const ROW_GAP = 34;
const TOP = 46;
const CHAIN_W = 206;
const CHAIN_GAP = 46;
const AGG_W = 290;
/** The weighted-term lanes run down a gutter right of the heads, one lane per head. */
const LANE_X0 = RIGHT_X + COL_W + 12;
const LANE_GAP = 8;
/** Below this many wall-clock seconds per step the phases would strobe: show occupancy. */
const LEGIBLE_STEP_SECONDS = 2.5;

type Pt = readonly [number, number];

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
  // Data enters at the first row and leaves from the last: the wires say where, not a midpoint.
  const entryY = cy(rows[0]![0]!);
  const exitY = cy(rows.at(-1)![0]!);
  const innerRight = innerX + innerW;

  const aggY = TOP + band + 58;
  const aggregate: Placed = { box: spec.aggregate, x: MID - AGG_W / 2, y: aggY, w: AGG_W };
  const chainY = aggY + BOX_H + 60;
  const chainTotal = spec.chain.length * CHAIN_W + (spec.chain.length - 1) * CHAIN_GAP;
  const chain: Placed[] = spec.chain.map((box, i) => ({
    box,
    x: MID - chainTotal / 2 + i * (CHAIN_W + CHAIN_GAP),
    y: chainY,
    w: CHAIN_W,
  }));
  // Room under the chain for its live gauges: gradient norm, learning rate.
  const height = chainY + BOX_H + 46;

  return {
    left,
    right,
    rows,
    containerY,
    containerH,
    entryY,
    exitY,
    innerX,
    innerRight,
    aggregate,
    chain,
    height,
  };
}

type Layout = ReturnType<typeof layout>;

/** The y of the bus in the gap between model row r and row r + 1. */
function gapY(geo: Layout, r: number): number {
  return geo.rows[r]![0]!.y + BOX_H + ROW_GAP / 2;
}

/**
 * Wires between consecutive model rows. Each box of the upper row drops into the gap, a bus
 * joins them, and each box of the lower row takes an arrow from it — so parallel boxes fan in
 * and out, and a single box connects straight through.
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

// ── routes: polylines the moving marks travel along ─────────────────────────────────────────

interface Route {
  readonly pts: readonly Pt[];
  /** Cumulative length at each vertex. */
  readonly cum: readonly number[];
  readonly len: number;
}

/** A box a route passes through, at a share of the route's length. */
interface Mark {
  readonly id: string;
  readonly at: number;
}

interface FlowPath {
  readonly route: Route;
  readonly marks: readonly Mark[];
}

/** Orthogonal polyline through points, inserting an elbow wherever both axes change. */
function ortho(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of points) {
    const last = out.at(-1);
    if (last && last[0] !== x && last[1] !== y) out.push([x, last[1]]);
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  return out;
}

function makeRoute(points: readonly Pt[]): Route {
  const pts = ortho(points);
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(
      cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]),
    );
  }
  return { pts, cum, len: Math.max(1e-6, cum.at(-1) ?? 0) };
}

function flowPath(points: readonly Pt[]): FlowPath {
  const route = makeRoute(points);
  return { route, marks: [] };
}

/** Marks placed at the route vertex matching each box centre. */
function marked(points: readonly Pt[], boxes: readonly Placed[]): FlowPath {
  const route = makeRoute(points);
  const marks = boxes.map((p) => {
    const index = route.pts.findIndex((pt) => pt[0] === cx(p) && pt[1] === cy(p));
    return { id: p.box.id, at: index < 0 ? 0 : route.cum[index]! / route.len };
  });
  return { route, marks };
}

function reversed(path: FlowPath): FlowPath {
  const pts = [...path.route.pts].reverse();
  const route = makeRoute(pts);
  return { route, marks: path.marks.map((mark) => ({ id: mark.id, at: 1 - mark.at })) };
}

function pointAt(route: Route, t: number): Pt {
  const target = clamp(t, 0, 1) * route.len;
  for (let i = 1; i < route.pts.length; i += 1) {
    if (route.cum[i]! >= target) {
      const a = route.pts[i - 1]!;
      const b = route.pts[i]!;
      const span = route.cum[i]! - route.cum[i - 1]!;
      const k = span > 0 ? (target - route.cum[i - 1]!) / span : 0;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
  }
  return route.pts.at(-1)!;
}

/** Path data for the first `t` of a route. */
function prefix(route: Route, t: number): string {
  const target = clamp(t, 0, 1) * route.len;
  let d = `M${route.pts[0]![0].toFixed(1)},${route.pts[0]![1].toFixed(1)}`;
  for (let i = 1; i < route.pts.length; i += 1) {
    if (route.cum[i]! >= target) {
      const [x, y] = pointAt(route, t);
      return `${d} L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    d += ` L${route.pts[i]![0].toFixed(1)},${route.pts[i]![1].toFixed(1)}`;
  }
  return d;
}

const hasParams = (box: ArchBox) =>
  !box.absent && (box.params === "trained" || box.params === "adapters");

interface Lane {
  readonly id: string;
  readonly key: string;
  readonly penalty: boolean;
  readonly path: FlowPath;
  readonly back: FlowPath;
  readonly d: string;
}

interface Flow {
  readonly placed: ReadonlyMap<string, Placed>;
  /** Forward paths from each connected source, traced source first. */
  readonly sources: readonly FlowPath[];
  readonly sourceIds: readonly string[];
  /** Distillation: the same inputs through the frozen teacher to the transfer targets. */
  readonly teacher: readonly FlowPath[];
  readonly heads: readonly {
    readonly id: string;
    readonly path: FlowPath;
    readonly back: FlowPath;
  }[];
  readonly lanes: readonly Lane[];
  /** Gradient paths from the model exit back to each upstream trainable module. */
  readonly back: readonly FlowPath[];
  /** Reinforcement learning: the policy-gradient path from the update back to the policy. */
  readonly rlReturn?: FlowPath;
  readonly fan?: { readonly origin: Pt; readonly tips: readonly Pt[] };
  /** Centre of the exposed reduce-scatter mark between backward and optimizer. */
  readonly reduceScatter?: Pt;
  readonly trainable: ReadonlySet<string>;
}

function laneGeometry(geo: Layout, index: number, count: number) {
  const agg = geo.aggregate;
  // The top head takes the outermost lane and the lowest entry, so no two lanes cross.
  const x = LANE_X0 + (count - 1 - index) * LANE_GAP;
  const span = count > 1 ? (BOX_H - 16) / (count - 1) : 0;
  return { x, y: count > 1 ? agg.y + BOX_H - 8 - index * span : cy(agg) };
}

function buildFlow(spec: ArchitectureSpec, geo: Layout, rl: boolean, group: number): Flow {
  const all = [...geo.left, ...geo.rows.flat(), ...geo.right, geo.aggregate, ...geo.chain];
  const placed = new Map(all.map((p) => [p.box.id, p]));
  const exit: Pt = [RIGHT_BUS, geo.exitY];

  /** The box of each row a flow passes through: the given first box, then the named variant. */
  const picksFrom = (first: Placed, variant: string | undefined, fromRow = 0) => {
    const picks: Placed[] = [first];
    for (let r = fromRow + 1; r < geo.rows.length; r += 1) {
      const row = geo.rows[r]!;
      picks.push(
        row.find((p) => p.box.id === variant) ??
          row.find((p) => hasParams(p.box)) ??
          row[0]!,
      );
    }
    return picks;
  };
  const throughModel = (
    picks: readonly Placed[],
    fromRow: number,
    toExit: boolean,
  ): Pt[] => {
    const pts: Pt[] = [];
    picks.forEach((p, i) => {
      pts.push([cx(p), cy(p)]);
      if (i < picks.length - 1) pts.push([cx(p), gapY(geo, fromRow + i)]);
    });
    if (toExit) pts.push([geo.innerRight, geo.exitY], exit);
    return pts;
  };

  const tracedFirst = [...geo.left].sort(
    (a, b) => Number(spec.trace.includes(b.box.id)) - Number(spec.trace.includes(a.box.id)),
  );
  const sources: FlowPath[] = [];
  const sourceIds: string[] = [];
  const teacher: FlowPath[] = [];
  for (const source of tracedFirst) {
    const into = source.box.feeds ? placed.get(source.box.feeds) : undefined;
    if (source.box.absent || !into || into.box.absent) continue;
    const entry: Pt[] = [
      [source.x + source.w, cy(source)],
      [LEFT_BUS, cy(source)],
      [LEFT_BUS, geo.entryY],
      [geo.innerX, geo.entryY],
    ];
    const picks = picksFrom(into, rl ? undefined : "student");
    sources.push(marked([...entry, ...throughModel(picks, 0, !rl)], [source, ...picks]));
    sourceIds.push(source.box.id);
    if (placed.has("teacher")) {
      const teacherPicks = picksFrom(into, "teacher");
      teacher.push(
        marked([...entry, ...throughModel(teacherPicks, 0, false)], teacherPicks),
      );
    }
  }

  const heads = geo.right
    .filter((p) => !p.box.absent)
    .map((p) => {
      const path = flowPath([exit, [RIGHT_BUS, cy(p)], [p.x, cy(p)]]);
      return { id: p.box.id, path, back: reversed(path) };
    });

  const lanes: Lane[] = [];
  geo.right.forEach((p, index) => {
    if (p.box.absent || !p.box.lossKey) return;
    const { x, y } = laneGeometry(geo, index, geo.right.length);
    const path = flowPath([
      [p.x + p.w, cy(p)],
      [x, cy(p)],
      [x, y],
      [geo.aggregate.x + geo.aggregate.w, y],
    ]);
    lanes.push({
      id: p.box.id,
      key: p.box.lossKey,
      penalty: p.box.detail.startsWith("−"),
      path,
      back: reversed(path),
      d: prefix(path.route, 1),
    });
  });

  const trainable = new Set(all.filter((p) => hasParams(p.box)).map((p) => p.box.id));

  // Gradient reaches every trainable module upstream of the loss and stops there: a frozen
  // encoder at the start of the model takes none, and nothing flows into a frozen teacher.
  const back: FlowPath[] = [];
  if (!rl) {
    const starts: { first: Placed; row: number }[] = geo.rows[0]!.filter((p) =>
      hasParams(p.box),
    ).map((first) => ({ first, row: 0 }));
    if (starts.length === 0) {
      for (let r = 1; r < geo.rows.length && starts.length === 0; r += 1) {
        const first = geo.rows[r]!.find((p) => hasParams(p.box));
        if (first) starts.push({ first, row: r });
      }
    }
    for (const { first, row } of starts) {
      const picks = picksFrom(first, "student", row);
      back.push(reversed(marked(throughModel(picks, row, true), picks)));
    }
  }

  let rlReturn: FlowPath | undefined;
  let fan: Flow["fan"];
  if (rl) {
    const [kl, update] = geo.chain;
    const policy = geo.rows[1]?.[0];
    const sampler = geo.rows.at(-1)![0]!;
    if (kl && update && policy) {
      const elbow = geo.aggregate.y + BOX_H + 30;
      const pts: Pt[] = [
        [cx(update), cy(update)],
        [cx(kl), cy(kl)],
        [cx(kl), elbow],
        [MID, elbow],
        [MID, cy(geo.aggregate)],
        [MID, cy(sampler)],
        [MID, cy(policy)],
      ];
      const boxes: Placed[] = [update, kl, sampler, policy];
      const encoder = geo.rows[0]!.find((p) => hasParams(p.box));
      if (encoder) {
        pts.push(
          [MID, gapY(geo, 0)],
          [cx(encoder), gapY(geo, 0)],
          [cx(encoder), cy(encoder)],
        );
        boxes.push(encoder);
      }
      // Single-box model rows are centred on MID, so their centres lie on this path.
      rlReturn = marked(pts, boxes);
    }
    fan = {
      origin: [geo.innerRight, geo.exitY],
      tips: Array.from({ length: group }, (_, k): Pt => [
        RIGHT_BUS - 3,
        geo.exitY + (k - (group - 1) / 2) * 7,
      ]),
    };
  }

  const [c0, c1] = geo.chain;
  const reduceScatter: Pt | undefined =
    !rl && c0 && c1 ? [(c0.x + c0.w + c1.x) / 2, cy(c0)] : undefined;

  return {
    placed,
    sources,
    sourceIds,
    teacher,
    heads,
    lanes,
    back,
    rlReturn,
    fan,
    reduceScatter,
    trainable,
  };
}

// ── the scene of one instant ────────────────────────────────────────────────────────────────

type LineStyle = "fwd" | "grad" | "nograd" | "occupancy" | "occupancyGrad";

interface SceneLine {
  readonly d: string;
  readonly style: LineStyle;
  readonly colour: string;
  readonly width?: number;
}

interface Lit {
  readonly colour: string;
  /** `outline` lights the box; `adapters` lights only its LoRA adapter strip. */
  readonly kind: "outline" | "adapters";
  readonly opacity: number;
}

interface Particle {
  readonly at: Pt;
  readonly colour: string;
  /** 0..1: trailing particles fade with distance behind the front. */
  readonly opacity: number;
}

/** An optimizer update: a ring expanding off a trainable box (or its LoRA strip) and fading. */
interface Ring {
  readonly id: string;
  readonly u: number;
  readonly adapters: boolean;
}

interface Scene {
  readonly lines: SceneLine[];
  readonly packets: { readonly at: Pt; readonly grad: boolean; readonly colour: string }[];
  /** Activations streaming behind a front, or through every path at replay speed. */
  readonly particles: Particle[];
  readonly rings: Ring[];
  readonly lit: Map<string, Lit>;
  /** Rays of the rollout fan, each 0..1 of its length. */
  rays: readonly number[];
  /** SFT: share of the supervised response positions lit by the loss; gradient on them. */
  tokens: number;
  tokenGrad: boolean;
  /** Exposed reduce-scatter progress, 0..1, when that phase is running. */
  reduceScatter: number | undefined;
  /** Reference log-prob progress through the frozen reference policy. */
  reference: number | undefined;
  /** Advantages drawn, 0..1. */
  advantages: number;
  /** Reinforcement learning: share of the group's completions verified and rewarded. */
  verified: number;
  /** Reinforcement learning: generation progress through the step's rollouts, 0..1. */
  gen: number;
  /** Distillation: teacher and student distributions drawn, 0..1 each. */
  teacher: number;
  student: number;
}

type Mode = "live" | "static" | "occupancy";

interface Instant {
  readonly phase: string;
  readonly within: number;
}

/** What drives motion that is not a phase front: the wall clock and the live gradient. */
interface Motion {
  /** Wall clock, ms. */
  readonly t: number;
  /** True only while the run is moving on screen: a paused run holds every mark still. */
  readonly animate: boolean;
  readonly grad: GradMagnitude | undefined;
}

/** Particle speed along a path at replay speed, figure units per second. */
const STREAM_SPEED = 110;
/** Distance between streamed particles, figure units. */
const STREAM_GAP = 46;
/** Travel of the gradient dash pattern, figure units per second. */
const DASH_SPEED = 26;

function sceneAt(
  flow: Flow,
  instant: Instant,
  mode: Mode,
  rl: boolean,
  motion: Motion,
): Scene {
  const scene: Scene = {
    lines: [],
    packets: [],
    particles: [],
    rings: [],
    lit: new Map(),
    rays: [],
    tokens: 0,
    tokenGrad: false,
    reduceScatter: undefined,
    reference: undefined,
    advantages: 0,
    verified: 0,
    gen: 1,
    teacher: 0,
    student: 0,
  };
  const group = flow.fan?.tips.length ?? 0;
  const gradWidth = motion.grad?.width;

  if (mode === "occupancy") {
    // Too fast to follow phase by phase: every path the step uses carries its traffic at
    // once — activations streaming forward, gradient dashes travelling back at the width of
    // the live gradient norm, the trainable blocks held lit by the steady run of updates.
    const forward = [
      ...flow.sources,
      ...flow.teacher,
      ...flow.heads.map((h) => h.path),
      ...flow.lanes.map((l) => l.path),
    ];
    for (const path of forward) {
      scene.lines.push({
        d: prefix(path.route, 1),
        style: "occupancy",
        colour: PHASE_COLOUR.forward!,
      });
      if (!motion.animate) continue;
      const travelled = (motion.t / 1000) * STREAM_SPEED;
      const count = Math.max(1, Math.floor(path.route.len / STREAM_GAP));
      for (let k = 0; k < count; k += 1) {
        const at = ((travelled + k * STREAM_GAP) % (count * STREAM_GAP)) / path.route.len;
        if (at > 1) continue;
        scene.particles.push({
          at: pointAt(path.route, at),
          colour: PHASE_COLOUR.forward!,
          opacity: 0.85,
        });
      }
    }
    for (const path of [...flow.back, ...(flow.rlReturn ? [flow.rlReturn] : [])]) {
      scene.lines.push({
        d: prefix(path.route, 1),
        style: "occupancyGrad",
        colour: PHASE_COLOUR.backward!,
        width: gradWidth,
      });
    }
    for (const id of flow.trainable) {
      const box = flow.placed.get(id)!.box;
      scene.lit.set(id, {
        colour: PHASE_COLOUR.optimizer!,
        kind: box.params === "adapters" ? "adapters" : "outline",
        opacity: 0.55,
      });
    }
    scene.rays = new Array(group).fill(1);
    scene.advantages = 1;
    scene.verified = 1;
    scene.tokens = 1;
    scene.teacher = 1;
    scene.student = 1;
    return scene;
  }

  const live = mode === "live";
  const u = live ? instant.within : 1;
  const colour = PHASE_COLOUR[instant.phase] ?? "var(--ink-primary)";
  const light = (id: string, c = colour, kind: Lit["kind"] = "outline", opacity = 1) => {
    if (opacity > 0.02) scene.lit.set(id, { colour: c, kind, opacity });
  };
  const draw = (
    path: FlowPath,
    t: number,
    style: LineStyle,
    c = colour,
    width = style === "grad" ? gradWidth : undefined,
  ) => {
    const tt = clamp(t, 0, 1);
    if (tt <= 0) return;
    scene.lines.push({ d: prefix(path.route, tt), style, colour: c, width });
    if (live && tt < 1) {
      scene.packets.push({
        at: pointAt(path.route, tt),
        grad: style === "grad",
        colour: c,
      });
      // Activations stream in behind the front: the batch is many sequences, not one packet.
      if (style === "fwd" && motion.animate) {
        for (let k = 1; k <= 4; k += 1) {
          const behind = tt - (k * 16) / path.route.len;
          if (behind <= 0) break;
          scene.particles.push({
            at: pointAt(path.route, behind),
            colour: c,
            opacity: 0.8 - k * 0.16,
          });
        }
      }
    }
  };
  /** Light the boxes a front has reached; gradient lights only what it updates. */
  const reach = (path: FlowPath, t: number, gradient: boolean, c = colour) => {
    for (const mark of path.marks) {
      if (t + 1e-9 < mark.at) continue;
      const box = flow.placed.get(mark.id)?.box;
      if (!box) continue;
      if (!gradient) light(mark.id, c);
      else if (box.params === "adapters") light(mark.id, c, "adapters");
      else if (hasParams(box)) light(mark.id, c);
    }
  };
  /** The optimizer step: every trainable block (only the adapters of a LoRA block) updates. */
  const pulse = (c: string, progress: number) => {
    for (const id of flow.trainable) {
      const box = flow.placed.get(id)!.box;
      const adapters = box.params === "adapters";
      light(id, c, adapters ? "adapters" : "outline", live ? 1 - progress : 1);
      if (live) scene.rings.push({ id, u: progress, adapters });
    }
  };

  switch (instant.phase) {
    case "data":
      for (const id of flow.sourceIds) light(id, colour, "outline", 0.9);
      break;
    case "teacher":
      for (const path of flow.teacher) {
        draw(path, u / 0.9, "fwd");
        reach(path, u / 0.9, false);
      }
      scene.teacher = u;
      break;
    case "forward": {
      const a = u / 0.6;
      flow.sources.forEach((path) => {
        draw(path, a, "fwd");
        reach(path, a, false);
      });
      if (u > 0.6) {
        const b = (u - 0.6) / 0.2;
        for (const head of flow.heads) {
          draw(head.path, b, "fwd");
          if (b >= 1) light(head.id);
        }
      }
      if (u > 0.8) {
        const c = (u - 0.8) / 0.2;
        for (const lane of flow.lanes) draw(lane.path, c, "fwd");
        scene.tokens = c;
        if (c >= 0.98) light("agg");
      }
      // Distillation: this micro-batch's teacher targets exist; the student's are forming.
      scene.teacher = 1;
      scene.student = clamp(u / 0.8, 0, 1);
      break;
    }
    case "backward": {
      light("backward");
      light("agg", colour, "outline", 0.6);
      scene.tokenGrad = true;
      scene.tokens = 1;
      scene.teacher = 1;
      scene.student = 1;
      const a = u / 0.15;
      for (const lane of flow.lanes) draw(lane.back, a, "grad");
      if (u > 0.15) {
        const b = (u - 0.15) / 0.15;
        for (const head of flow.heads) {
          draw(head.back, b, "grad");
          const box = flow.placed.get(head.id)?.box;
          if (b >= 1 && box && hasParams(box)) light(head.id);
        }
      }
      if (u > 0.3) {
        const d = (u - 0.3) / 0.7;
        for (const path of flow.back) {
          draw(path, d, "grad");
          reach(path, d, true);
        }
      }
      break;
    }
    case "comm":
      scene.reduceScatter = u;
      light("backward", colour, "outline", 0.5);
      scene.tokens = 1;
      scene.teacher = 1;
      scene.student = 1;
      break;
    case "optimizer":
      light(flow.placed.has("optimizer") ? "optimizer" : "grpo");
      pulse(colour, u);
      scene.tokens = 1;
      scene.teacher = 1;
      scene.student = 1;
      break;

    // verl's order: rollout generation, reward, old and reference log-probs, advantages, update.
    case "gen": {
      for (const path of flow.sources) {
        draw(path, u / 0.08, "fwd");
        reach(path, u / 0.08, false);
      }
      scene.rays = Array.from({ length: group }, (_, k) =>
        live ? Math.min(1, instant.within / completionFinish(k, group)) : 1,
      );
      scene.gen = live ? instant.within : 1;
      break;
    }
    case "reward": {
      const n = Math.max(1, flow.heads.length);
      flow.heads.forEach((head, k) => {
        const b = (u - (k / n) * 0.55) / 0.2;
        draw(head.path, b, "fwd");
        if (b >= 1) light(head.id);
      });
      scene.rays = new Array(group).fill(1);
      // Completions are verified as the verifier stack returns: the group's rewards fill in.
      scene.verified = clamp(u / 0.75, 0, 1);
      if (u > 0.75) {
        const c = (u - 0.75) / 0.25;
        for (const lane of flow.lanes) draw(lane.path, c, "fwd");
        if (c >= 0.98) light("agg");
      }
      break;
    }
    case "old_log_prob": {
      // The actor re-scores its own completions: a forward pass with no gradient, per micro-batch.
      const sweep = live ? (instant.within * 3) % 1 : 1;
      for (const path of flow.sources) draw(path, sweep, "nograd");
      light("policy");
      break;
    }
    case "ref":
      scene.reference = u;
      light("kl");
      break;
    case "adv":
      scene.advantages = u;
      light("agg", "var(--ink-primary)");
      break;
    case "update_actor": {
      light("grpo");
      light("kl", colour, "outline", 0.5);
      if (flow.rlReturn) {
        draw(flow.rlReturn, u / 0.85, "grad");
        reach(flow.rlReturn, u / 0.85, true);
      }
      scene.tokenGrad = true;
      // Each PPO mini-batch ends in its own optimizer step on the trainable parameters.
      if (u > 0.85) pulse(PHASE_COLOUR.optimizer!, (u - 0.85) / 0.15);
      break;
    }
  }
  if (rl && instant.phase !== "gen" && instant.phase !== "reward") scene.verified = 1;
  if (rl && instant.phase !== "gen" && scene.rays.length === 0) {
    scene.rays = new Array(group).fill(1);
  }
  // This step's advantages exist once they have been computed.
  if (instant.phase === "update_actor") scene.advantages = 1;
  return scene;
}

// ── drawing ─────────────────────────────────────────────────────────────────────────────────

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

/** Room kept at the right of a box for its live readout. */
const READOUT: Record<string, number> = { agg: 96 };

const frozenBox = (box: ArchBox) =>
  box.params === "frozen" || box.params === "adapters" || box.frozen;

function Box({ p, reserve }: { readonly p: Placed; readonly reserve: number }) {
  const { box } = p;
  const titleMax = Math.floor((p.w - 48 - (reserve > 100 ? reserve - 40 : 0)) / 6.5);
  const detailMax = Math.floor((p.w - 48 - reserve) / 6.3);
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  const role =
    box.params === "adapters"
      ? " (frozen weights, LoRA adapters trained)"
      : box.params === "frozen" || box.frozen
        ? " (frozen weights)"
        : box.params === "trained"
          ? " (trained)"
          : "";
  return (
    <g
      className={css.box}
      data-absent={box.absent || undefined}
      transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
    >
      <title>{`${box.title} — ${box.note ?? box.detail}${box.absent ? " (not connected)" : ""}${role}`}</title>
      <rect width={p.w} height={BOX_H} rx={3} />
      {frozenBox(box) && !box.absent && (
        <rect className={css.hatch} width={p.w} height={BOX_H} rx={3} />
      )}
      {box.params === "adapters" && !box.absent && (
        <rect className={css.adapters} x={40} y={BOX_H - 9} width={p.w - 52} height={4} />
      )}
      {box.share !== undefined && !box.absent && (
        <>
          <rect
            className={css.shareTrack}
            x={40}
            y={BOX_H - 7}
            width={p.w - 52}
            height={2}
          />
          <rect
            className={css.shareFill}
            x={40}
            y={BOX_H - 7}
            width={Math.max(1, (p.w - 52) * box.share)}
            height={2}
          />
        </>
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

const Boxes = memo(function Boxes({ geo }: { readonly geo: Layout }) {
  return (
    <g>
      {[...geo.left, ...geo.rows.flat(), ...geo.right, geo.aggregate, ...geo.chain].map(
        (p) => (
          <Box
            key={p.box.id}
            p={p}
            reserve={READOUT[p.box.id] ?? (p.box.lossKey ? 56 : 0)}
          />
        ),
      )}
    </g>
  );
});

/** Wires, container and model-internal wiring: everything that never changes with the run. */
const Wiring = memo(function Wiring({
  spec,
  geo,
  flow,
  inset,
  group,
}: {
  readonly spec: ArchitectureSpec;
  readonly geo: Layout;
  readonly flow: Flow;
  readonly inset: InsetKind;
  readonly group: number;
}) {
  const busLeft = [...geo.left.map(cy), geo.entryY];
  const busRight = [...geo.right.map(cy), geo.exitY];
  const wires = rowWires(geo);
  const agg = geo.aggregate;
  const first = geo.chain[0];
  const sampler = geo.rows.at(-1)![0]!;
  return (
    <>
      <rect width={W} height={geo.height} fill="url(#arch-dots)" />
      <text className={css.columnTitle} x={LEFT_X} y={TOP - 16}>
        {spec.sourcesTitle.toUpperCase()}
      </text>
      <text className={css.columnTitle} x={RIGHT_X} y={TOP - 16}>
        {spec.headsTitle.toUpperCase()}
      </text>

      <g className={css.wire}>
        {geo.left.map((p) => (
          <path key={p.box.id} d={`M${p.x + p.w},${cy(p)} H${LEFT_BUS}`} />
        ))}
        <path d={`M${LEFT_BUS},${Math.min(...busLeft)} V${Math.max(...busLeft)}`} />
        <path
          d={`M${LEFT_BUS},${geo.entryY} H${geo.innerX}`}
          markerEnd="url(#arch-arrow)"
        />
        <path d={`M${geo.innerRight},${geo.exitY} H${RIGHT_BUS}`} />
        <path d={`M${RIGHT_BUS},${Math.min(...busRight)} V${Math.max(...busRight)}`} />
        {geo.right.map((p) => (
          <path
            key={p.box.id}
            d={`M${RIGHT_BUS},${cy(p)} H${p.x}`}
            markerEnd="url(#arch-arrow)"
          />
        ))}
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
      {flow.rlReturn && (
        // The policy gradient returns from the update to the policy; verifiers are not on it.
        <path
          className={css.returnWire}
          d={`M${MID},${agg.y} V${sampler.y + BOX_H}`}
          markerEnd="url(#arch-arrow)"
        />
      )}

      <g className={css.container} transform={`translate(${CENTER_X} ${geo.containerY})`}>
        <rect width={CENTER_W} height={geo.containerH} rx={4} />
        <text className={css.containerTitle} x={CENTER_W / 2} y={24}>
          {spec.modelTitle}
        </text>
        <text className={css.containerDetail} x={CENTER_W / 2} y={40}>
          {spec.modelDetail}
        </text>
      </g>
      <g className={css.wire}>
        {wires.map((wire) => (
          <path
            key={wire.d}
            d={wire.d}
            markerEnd={wire.arrow ? "url(#arch-arrow)" : undefined}
          />
        ))}
      </g>

      {flow.fan && (
        <g className={css.fanRest}>
          {flow.fan.tips.map((tip, k) => (
            <path
              key={k}
              d={`M${flow.fan!.origin[0]},${flow.fan!.origin[1]} L${tip[0]},${tip[1]}`}
            />
          ))}
        </g>
      )}

      {flow.reduceScatter && (
        <g
          className={css.rsRest}
          transform={`translate(${flow.reduceScatter[0]} ${flow.reduceScatter[1]})`}
        >
          <path d="M-14,-10 L10,0 M-14,-3.3 L10,0 M-14,3.3 L10,0 M-14,10 L10,0" />
        </g>
      )}

      {(inset === "ntp" || inset === "masked") && (
        <SequenceInset
          geo={geo}
          kind={inset}
          lit={0}
          grad={false}
          gradWidth={1}
          losses={[]}
          value={undefined}
          rest
        />
      )}
      {inset === "rollout" && <RolloutInset geo={geo} group={group} rest />}
      {inset === "transfer" && (
        <TransferInset
          geo={geo}
          pair={undefined}
          teacher={0}
          student={0}
          grad={false}
          gradWidth={1}
          rest
        />
      )}
    </>
  );
});

// ── stage insets: what one sequence, one group, one position looks like inside the step ─────

/**
 * The space left of the aggregate, below the sources, is where each stage shows its loss at
 * the scale of one sequence: next-token targets, masked positions, a rollout group, or the
 * teacher's distribution against the student's. The inset feeds the aggregate with a wire.
 */
function insetFrame(geo: Layout) {
  const agg = geo.aggregate;
  const x = LEFT_X + 8;
  return { x, w: agg.x - 34 - x, cy: cy(agg), agg };
}

type InsetKind = "ntp" | "masked" | "rollout" | "transfer" | undefined;

function insetKind(stageId: string | undefined): InsetKind {
  switch (stageId) {
    case "pretraining":
      return "ntp";
    case "sft":
      return "masked";
    case "rl":
      return "rollout";
    case "distillation":
      return "transfer";
    default:
      return undefined;
  }
}

/** Positions of the drawn sequence, per stage: which carry loss and which are masked. */
const SEQUENCE = {
  // An interleaved image–text sequence: image patch tokens carry no next-token target.
  ntp: [
    { part: "patches", count: 6, supervised: false },
    { part: "text", count: 14, supervised: true },
  ],
  // A chat sequence: system and user turns are masked; the loss is on the response.
  masked: [
    { part: "prompt", count: 12, supervised: false },
    { part: "response", count: 7, supervised: true },
    { part: "", count: 1, supervised: false },
  ],
} as const;

const sequenceCells = (kind: "ntp" | "masked") => {
  const cells: { i: number; supervised: boolean; order: number; s: number }[] = [];
  let supervisedSeen = 0;
  const total = SEQUENCE[kind].reduce((sum, part) => sum + part.count, 0);
  const supervisedTotal = SEQUENCE[kind]
    .filter((part) => part.supervised)
    .reduce((sum, part) => sum + part.count, 0);
  for (const part of SEQUENCE[kind]) {
    for (let k = 0; k < part.count; k += 1) {
      if (part.supervised) supervisedSeen += 1;
      cells.push({
        i: cells.length,
        supervised: part.supervised,
        order: part.supervised ? supervisedSeen / supervisedTotal : 0,
        s: supervisedSeen - 1,
      });
    }
  }
  return { cells, total, supervisedTotal };
};

/** Supervised positions in the drawn sequence of a stage. */
function supervisedCount(kind: "ntp" | "masked"): number {
  return sequenceCells(kind).supervisedTotal;
}

function SequenceInset({
  geo,
  kind,
  lit,
  grad,
  gradWidth,
  losses,
  value,
  rest = false,
}: {
  readonly geo: Layout;
  readonly kind: "ntp" | "masked";
  /** Share of supervised positions the loss has reached. */
  readonly lit: number;
  readonly grad: boolean;
  readonly gradWidth: number;
  /** Per-position loss of each supervised position, in order. */
  readonly losses: readonly number[];
  readonly value: number | undefined;
  readonly rest?: boolean;
}) {
  const { x, w, cy: y0, agg } = insetFrame(geo);
  const { cells, total } = sequenceCells(kind);
  const cell = (w - (total - 1) * 2) / total;
  const y = y0 - 7;
  const at = (i: number) => x + i * (cell + 2);
  if (rest) {
    const starts = SEQUENCE[kind].map((_, index) =>
      SEQUENCE[kind].slice(0, index).reduce((sum, part) => sum + part.count, 0),
    );
    return (
      <g aria-hidden="true">
        {cells.map((c) => (
          <rect
            key={c.i}
            className={c.supervised ? css.tokenSupervised : css.tokenMasked}
            x={at(c.i)}
            y={y}
            width={cell}
            height={14}
          />
        ))}
        <path
          className={css.wireSingle}
          d={`M${x + w + 4},${y0} H${agg.x}`}
          markerEnd="url(#arch-arrow)"
        />
        {SEQUENCE[kind].map((part, index) =>
          part.part ? (
            <text key={part.part} className={css.inset} x={at(starts[index]!)} y={y + 28}>
              {part.part}
            </text>
          ) : null,
        )}
      </g>
    );
  }
  const peak = Math.max(1e-9, ...losses);
  return (
    <g aria-hidden="true">
      {cells.map((c) => {
        if (!c.supervised) return null;
        const on = lit >= c.order - 1e-9;
        const loss = losses[c.s] ?? 0;
        const h = 4 + 30 * (loss / peak);
        return (
          <g key={c.i}>
            {on && (
              <>
                <rect className={css.tokenLit} x={at(c.i)} y={y} width={cell} height={14} />
                <rect
                  className={css.lossBar}
                  x={at(c.i) + 1}
                  y={y - 3 - h}
                  width={Math.max(1, cell - 2)}
                  height={h}
                />
              </>
            )}
            {grad && (
              <rect
                className={css.tokenGrad}
                x={at(c.i)}
                y={y}
                width={cell}
                height={14}
                style={{ strokeWidth: Math.max(1.2, gradWidth / 1.6) }}
              />
            )}
          </g>
        );
      })}
      {value !== undefined && (
        <text className={css.insetValue} x={x + w} y={y - 44}>
          {kind === "ntp" ? "CE " : "L "}
          {fmtTerm(value)}
        </text>
      )}
    </g>
  );
}

/** max_response_length of the rollout config (config.ts): the drawn row's full width. */
const MAX_RESPONSE_TOKENS = 4096;
/** Mean multimodal prompt length of the RL prompt pool (telemetry `prompt_length/mean`). */
const RL_PROMPT_TOKENS = 1852;
const ROLLOUT_PITCH = 13;

function rolloutRows(geo: Layout, group: number) {
  const { x, w, cy: y0 } = insetFrame(geo);
  const top = y0 - (group * ROLLOUT_PITCH - 4) / 2;
  return {
    x,
    barW: w - 100,
    rewardX: x + w - 88,
    advX: x + w - 42,
    rowY: (k: number) => top + k * ROLLOUT_PITCH,
    top,
  };
}

/**
 * One prompt group of the GRPO batch: G completions of the same prompt, each a row — its
 * prompt masked, its response streaming in as it decodes (shortest first, on the console's
 * long-tailed completion curve), then its verifier reward, then its group-relative
 * advantage; the update pushes gradient back through each response by its advantage.
 */
function RolloutInset({
  geo,
  group,
  rest = false,
  gen = 1,
  lengths = [],
  rewards = [],
  verified = 0,
  advantages = [],
  advantagesShown = 0,
  grad = false,
  gradWidth = 1,
}: {
  readonly geo: Layout;
  readonly group: number;
  readonly rest?: boolean;
  /** Generation progress, 0..1, when generation is running; 1 after. */
  readonly gen?: number;
  readonly lengths?: readonly number[];
  readonly rewards?: readonly number[];
  readonly verified?: number;
  readonly advantages?: readonly number[];
  readonly advantagesShown?: number;
  readonly grad?: boolean;
  readonly gradWidth?: number;
}) {
  const { x, barW, rewardX, advX, rowY, top } = rolloutRows(geo, group);
  const { w, cy: y0, agg } = insetFrame(geo);
  const scale = barW / (RL_PROMPT_TOKENS + MAX_RESPONSE_TOKENS);
  const promptW = RL_PROMPT_TOKENS * scale;
  if (rest) {
    return (
      <g aria-hidden="true">
        {Array.from({ length: group }, (_, k) => (
          <g key={k}>
            <rect
              className={css.tokenMasked}
              x={x}
              y={rowY(k)}
              width={promptW}
              height={9}
            />
            <rect
              className={css.rowTrack}
              x={x + promptW + 2}
              y={rowY(k)}
              width={barW - promptW - 2}
              height={9}
            />
            <rect
              className={css.rewardCell}
              x={rewardX}
              y={rowY(k)}
              width={12}
              height={9}
            />
          </g>
        ))}
        <path className={css.advBase} d={`M${advX},${top - 4} V${rowY(group - 1) + 13}`} />
        <text className={css.inset} x={x} y={top - 8}>
          prompt
        </text>
        <text className={css.inset} x={x + promptW + 2} y={top - 8}>
          response
        </text>
        <text className={css.insetHead} x={rewardX + 6} y={top - 8}>
          r
        </text>
        <text className={css.insetHead} x={advX} y={top - 8}>
          Â
        </text>
        <path
          className={css.wireSingle}
          d={`M${x + w + 4},${y0} H${agg.x}`}
          markerEnd="url(#arch-arrow)"
        />
      </g>
    );
  }
  return (
    <g aria-hidden="true">
      {lengths.map((length, k) => {
        const done = Math.min(1, gen / Math.max(1e-9, completionFinish(k, group)));
        const drawn = Math.min(MAX_RESPONSE_TOKENS, length) * scale * done;
        const y = rowY(k);
        const reward = rewards[k] ?? 0;
        const adv = advantages[k] ?? 0;
        const rewarded = verified * group >= k + 1 - 1e-9;
        const span = clamp(adv, -2, 2) * 18 * advantagesShown;
        return (
          <g key={k}>
            <rect
              className={css.tokenLit}
              x={x + promptW + 2}
              y={y + 1}
              width={Math.max(0, drawn - 2)}
              height={7}
            />
            {done < 1 && drawn > 0 && (
              <rect
                className={css.cursor}
                x={x + promptW + drawn}
                y={y - 1}
                width={2}
                height={11}
              />
            )}
            {rewarded && (
              <rect
                x={rewardX}
                y={y}
                width={12}
                height={9}
                style={{ fill: scaleColour(0.1 + 0.9 * reward) }}
              />
            )}
            {advantagesShown > 0 && Math.abs(span) > 0.2 && (
              <rect
                className={css.advRow}
                data-negative={adv < 0 || undefined}
                x={span >= 0 ? advX : advX + span}
                y={y + 1}
                width={Math.abs(span)}
                height={7}
              />
            )}
            {grad && Math.abs(adv) > 1e-6 && (
              <path
                className={css.rowGrad}
                d={`M${x + promptW + Math.max(2, drawn)},${y + 4.5} H${x + promptW + 2}`}
                style={{ strokeWidth: Math.min(gradWidth, 0.8 + 1.4 * Math.abs(adv)) }}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Distillation at one position: the teacher's temperature-2 distribution over the top of the
 * vocabulary against the student's, with exactly the live forward-KL term between them, and
 * a slice of the teacher's hidden state against the projected student's, with exactly the
 * live hidden-state MSE. The teacher is drawn in the frozen grammar, the student solid.
 */
function TransferInset({
  geo,
  pair,
  teacher,
  student,
  grad,
  gradWidth,
  rest = false,
}: {
  readonly geo: Layout;
  readonly pair: TransferPair | undefined;
  readonly teacher: number;
  readonly student: number;
  readonly grad: boolean;
  readonly gradWidth: number;
  readonly rest?: boolean;
}) {
  const { x, w, cy: y0, agg } = insetFrame(geo);
  const logitsW = Math.round(w * 0.46);
  const hiddenX = x + logitsW + 30;
  const hiddenW = x + w - hiddenX;
  const base = y0 + 30;
  const axis = y0 - 2;
  if (rest) {
    return (
      <g aria-hidden="true">
        <path className={css.advBase} d={`M${x},${base} H${x + logitsW}`} />
        <path className={css.advBase} d={`M${hiddenX},${axis} H${hiddenX + hiddenW}`} />
        <text className={css.inset} x={x} y={base + 16}>
          p · T=2
        </text>
        <text className={css.inset} x={hiddenX} y={base + 16}>
          h · d[0:16]
        </text>
        <path
          className={css.wireSingle}
          d={`M${x + w + 4},${y0} H${agg.x}`}
          markerEnd="url(#arch-arrow)"
        />
      </g>
    );
  }
  if (!pair) return null;
  const bins = pair.teacher.length;
  const pitch = logitsW / bins;
  const peak = Math.max(...pair.teacher, ...pair.student);
  const barH = (p: number) => (58 * p) / peak;
  const dims = pair.hiddenTeacher.length;
  const dPitch = hiddenW / dims;
  const hScale = 13;
  return (
    <g aria-hidden="true">
      {pair.teacher.map((p, i) => {
        const t = barH(p) * teacher;
        const s = barH(pair.student[i] ?? 0) * student;
        const bx = x + i * pitch;
        return (
          <g key={i}>
            {t > 0.2 && (
              <>
                <rect
                  className={css.teacherBar}
                  x={bx + 1}
                  y={base - t}
                  width={pitch - 3}
                  height={t}
                />
                <rect
                  className={css.hatch}
                  x={bx + 1}
                  y={base - t}
                  width={pitch - 3}
                  height={t}
                />
              </>
            )}
            {s > 0.2 && (
              <rect
                className={css.studentBar}
                x={bx + pitch / 2 - 3}
                y={base - s}
                width={4}
                height={s}
              />
            )}
            {grad && Math.abs(t - s) > 1 && (
              <path
                className={css.rowGrad}
                d={`M${bx + pitch / 2 - 1},${base - s} V${base - t}`}
                style={{ strokeWidth: Math.max(1.2, gradWidth / 1.5) }}
              />
            )}
          </g>
        );
      })}
      {pair.hiddenTeacher.map((v, i) => {
        const hx = hiddenX + i * dPitch;
        const t = v * hScale * teacher;
        const sv = (pair.hiddenStudent[i] ?? 0) * hScale * student;
        return (
          <g key={i}>
            {Math.abs(t) > 0.2 && (
              <rect
                className={css.teacherBar}
                x={hx + 1}
                y={t >= 0 ? axis - t : axis}
                width={dPitch - 3}
                height={Math.abs(t)}
              />
            )}
            {Math.abs(sv) > 0.2 && (
              <rect
                className={css.studentBar}
                x={hx + dPitch / 2 - 2.5}
                y={sv >= 0 ? axis - sv : axis}
                width={3}
                height={Math.abs(sv)}
              />
            )}
            {grad && Math.abs(t - sv) > 1 && (
              <path
                className={css.rowGrad}
                d={`M${hx + dPitch / 2 - 1},${axis - sv} V${axis - t}`}
                style={{ strokeWidth: Math.max(1.2, gradWidth / 1.5) }}
              />
            )}
          </g>
        );
      })}
      <text className={css.insetValue} x={x + logitsW} y={base - 66}>
        KL {fmtTerm(pair.kl)}
      </text>
      <text className={css.insetValue} x={hiddenX + hiddenW} y={base - 66}>
        MSE {fmtTerm(pair.mse)}
      </text>
    </g>
  );
}

const fmtStep = (value: number) => Math.round(value).toLocaleString("en-US");
const fmtTerm = (value: number) =>
  Math.abs(value) >= 1 ? value.toFixed(3) : value.toFixed(4);

function subscribeMotion(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const prefersReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Replay {
  readonly startedAt: number;
  readonly step: number;
}

/**
 * Live gauges under a chain box: the pre-clip gradient norm against the clip threshold, and
 * the learning rate against its peak. Same values as the console's `grad_norm` and
 * `learning_rate` for the step executing.
 */
function ChainGauges({
  p,
  grad,
  lr,
}: {
  readonly p: Placed;
  readonly grad: GradMagnitude | undefined;
  readonly lr: { readonly value: number; readonly peak: number } | undefined;
}) {
  const both = Boolean(grad && lr);
  const w = both ? p.w / 2 - 6 : p.w;
  const y = p.y + BOX_H + 6;
  // The norm's track spans 0..1.6 × max_norm, so the clip threshold sits at 62.5 %.
  const span = 1.6;
  return (
    <g className={css.gauge}>
      {grad && (
        <g data-state={grad.skipped ? "skipped" : grad.clipped ? "clipped" : undefined}>
          <title>
            {`Gradient norm before clipping ${Number.isFinite(grad.norm) ? grad.norm.toFixed(4) : "nan"}, max_norm ${MAX_GRAD_NORM.toFixed(1)}${grad.clipped ? ", clipped" : ""}${grad.skipped ? ", optimizer step skipped" : ""}`}
          </title>
          <text x={p.x} y={y + 12}>
            ‖g‖ {Number.isFinite(grad.norm) ? grad.norm.toFixed(3) : "nan"}
            {grad.clipped ? " clip" : ""}
          </text>
          <rect className={css.gaugeTrack} x={p.x} y={y + 18} width={w} height={3} />
          <rect
            className={css.gaugeFill}
            x={p.x}
            y={y + 18}
            width={w * Math.min(1, grad.share / span)}
            height={3}
          />
          <path className={css.gaugeTick} d={`M${p.x + w / span},${y + 15} V${y + 24}`} />
        </g>
      )}
      {lr && (
        <g>
          <title>{`Learning rate ${lr.value.toExponential(3)}, peak ${lr.peak.toExponential(1)}`}</title>
          <text x={p.x + (both ? w + 12 : 0)} y={y + 12}>
            lr {lr.value.toExponential(2)}
          </text>
          <rect
            className={css.gaugeTrack}
            x={p.x + (both ? w + 12 : 0)}
            y={y + 18}
            width={w}
            height={3}
          />
          <rect
            className={css.gaugeFill}
            data-lr
            x={p.x + (both ? w + 12 : 0)}
            y={y + 18}
            width={w * clamp(lr.value / Math.max(1e-30, lr.peak), 0, 1)}
            height={3}
          />
        </g>
      )}
    </g>
  );
}

export function ArchitectureFigure({
  spec,
  running,
}: {
  readonly spec: ArchitectureSpec;
  readonly running: boolean;
  /** Kept for callers; the figure now follows the run rather than one sample. */
  readonly sampleTag?: string | undefined;
  readonly stepSeconds?: number;
}) {
  const clock = useRunClock();
  const stage = clock?.stage;
  const rl = stage?.id === "rl";
  const group = stage?.run.rolloutsPerStep ?? 8;
  const geo = useMemo(() => layout(spec), [spec]);
  const flow = useMemo(() => buildFlow(spec, geo, rl, group), [spec, geo, rl, group]);
  const reduced = useSyncExternalStore(subscribeMotion, prefersReduced, () => true);
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [inView, setInView] = useState(false);
  const figure = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { threshold: 0.05 },
    );
    if (figure.current) observer.observe(figure.current);
    return () => observer.disconnect();
  }, []);

  const held = heldAt !== null;
  const moving = Boolean(clock) && running && !held && inView && !reduced;
  const speed = clock?.control.speed ?? 1;
  const stepsPerSecond = stage?.run.stepsPerSecond ?? 1;
  const wallStep = 1 / Math.max(1e-9, stepsPerSecond * speed);
  const fast = wallStep < LEGIBLE_STEP_SECONDS;
  // Occupancy streams particles continuously, so it needs a smooth clock too; 24 Hz is enough.
  const ticking = useFrameClock(moving, clock?.now ?? 0, figure, fast && !replay ? 24 : 30);
  const describedBy = useId();
  const t = heldAt ?? ticking;

  const context = useMemo(
    () =>
      clock
        ? { stage: clock.stage, profile: clock.profile, config: clock.config }
        : undefined,
    [clock],
  );
  const total = stage?.run.totalSteps ?? 1;
  const exact = clock && !clock.blocked ? stepAt(clock.control, clock.stage.run, t) : 0;
  const completed = Math.floor(exact);

  // A replay walks one step from its start at a legible pace, whatever the replay speed.
  const replayFrame = useMemo(
    () => (context && replay ? frameAt(context, replay.step) : undefined),
    [context, replay],
  );
  const replayMs = replayFrame ? clamp(replayFrame.stepSeconds, 8, 24) * 1000 : 0;
  const replaying =
    replay !== null &&
    replayFrame !== undefined &&
    running &&
    t - replay.startedAt < replayMs;

  const executing = replaying ? replay!.step : Math.min(total, completed + 1);
  const fraction = replaying
    ? clamp((t - replay!.startedAt) / replayMs, 0, 1)
    : exact >= total
      ? 1
      : exact - completed;
  const frame: StepFrame | undefined = useMemo(
    () => (context ? frameAt(context, executing) : undefined),
    [context, executing],
  );
  const microBatches = clock ? accumulation(clock.config, clock.profile.gpus) : 1;
  const segments: readonly Segment[] = useMemo(
    () => (stage && frame ? stepSegments(stage.id, frame, microBatches) : []),
    [stage, frame, microBatches],
  );
  const moment = segments.length ? momentOf(segments, fraction) : undefined;
  const terms: LiveTerms | undefined = useMemo(
    () => (stage ? liveTerms(stage, executing) : undefined),
    [stage, executing],
  );
  const advantages = useMemo(
    () =>
      frame?.rl
        ? groupAdvantages(
            frame.step,
            frame.rl.scoreMean,
            frame.rl.zeroVarianceGroups,
            group,
          )
        : [],
    [frame, group],
  );
  const klAlert = useMemo(() => {
    const curve = stage?.curves
      .flatMap((tab) => tab.curves)
      .find((c) => c.key === "kl-alert");
    return stage && curve ? curveAt(curve, executing, stage) : undefined;
  }, [stage, executing]);

  const inset = insetKind(stage?.id);
  const grad = useMemo(() => (frame ? gradMagnitude(frame) : undefined), [frame]);
  const rewards = useMemo(
    () =>
      frame?.rl
        ? groupRewards(frame.step, frame.rl.scoreMean, frame.rl.zeroVarianceGroups, group)
        : [],
    [frame, group],
  );
  // Completion lengths of the group, long-tailed around the logged mean response length;
  // shortest first, the order in which the console's completion curve finishes them.
  const rolloutLengths = useMemo(
    () =>
      frame?.rl
        ? [
            ...tokenLosses(
              "rl:response-length",
              frame.step,
              frame.rl.responseLengthMean,
              group,
            ),
          ].sort((a, b) => a - b)
        : [],
    [frame, group],
  );
  const sequenceValue =
    inset === "ntp"
      ? terms?.terms.find((term) => term.key === "mlm")?.value
      : inset === "masked"
        ? terms?.total
        : undefined;
  const sequenceLosses = useMemo(
    () =>
      (inset === "ntp" || inset === "masked") && sequenceValue !== undefined
        ? tokenLosses(inset, executing, sequenceValue, supervisedCount(inset))
        : [],
    [inset, executing, sequenceValue],
  );
  const transfer = useMemo(() => {
    if (inset !== "transfer" || !terms) return undefined;
    const kl = terms.terms.find((term) => term.key === "kd-kl")?.value;
    const mse = terms.terms.find((term) => term.key === "hidden")?.value;
    return kl === undefined || mse === undefined
      ? undefined
      : transferPair(executing, kl, mse);
  }, [inset, terms, executing]);

  const mode: Mode = reduced ? "static" : fast && !replaying ? "occupancy" : "live";
  const scene =
    moment && clock
      ? sceneAt(flow, { phase: moment.segment.phase, within: moment.within }, mode, rl, {
          t,
          animate: moving,
          grad,
        })
      : undefined;
  // Gradient dashes travel the way the gradient does: from the loss back toward the inputs.
  const dashOffset = moving ? -(((t / 1000) * DASH_SPEED) % 10) : 0;

  // Checkpoint and evaluation writes follow the step that triggers them. At fast replay a
  // single step is gone in a frame, so the mark is held for about a second and a half.
  const hold = Math.max(1, Math.ceil(1.5 * stepsPerSecond * speed));
  const every = stage?.run.checkpointEvery ?? 1;
  const evalCadence = stage ? evalEvery(stage) : 1;
  const saving = completed >= every && completed % every < hold;
  const evaluating = completed >= evalCadence && completed % evalCadence < hold;
  // The checkpoint write as a pulse: the updated weights leave the optimizer for storage.
  // Progress 0..1 over about a second and a half of wall time after the saving step lands.
  const sinceSave = completed >= every ? (completed % every) + fraction : Infinity;
  const savePulse =
    moving && !replaying ? (fast ? sinceSave / hold : (sinceSave * wallStep) / 1.6) : 1;
  const updateBox = flow.placed.get(flow.placed.has("optimizer") ? "optimizer" : "grpo");
  const checkpointBox = flow.placed.get("checkpoint");

  // ── readouts ──────────────────────────────────────────────────────────────────────────────
  const segment = moment?.segment;
  const completions = clock ? clock.config.globalBatch * group : 0;
  const detail = !segment
    ? ""
    : segment.phase === "gen"
      ? `${completionsDone(moment!.within, completions).toLocaleString("en-US")}/${completions.toLocaleString("en-US")} completions`
      : segment.part && segment.parts
        ? `${rl ? "PPO mini-batch" : "micro-batch"} ${segment.part}/${segment.parts}`
        : segment.phase === "comm"
          ? "reduce-scatter"
          : segment.phase === "optimizer"
            ? "AdamW"
            : "";
  const phaseText = segment
    ? [segment.label.toLowerCase(), detail].filter(Boolean).join(" · ")
    : "";
  const figureLabel = segment
    ? `${spec.figure} — step ${fmtStep(executing)} of ${fmtStep(total)}, ${phaseText}`
    : spec.figure;

  const byKey = new Map((terms?.terms ?? []).map((term) => [term.key, term]));
  const magnitude =
    (terms?.terms ?? []).reduce((sum, term) => sum + Math.abs(term.contribution), 0) || 1;
  const maxTerm = Math.max(
    1e-9,
    ...(terms?.terms ?? []).map((term) => Math.abs(term.contribution)),
  );
  const agg = geo.aggregate;
  const refPacket = scene?.packets[0];
  const hasAdapters = [...flow.placed.values()].some((p) => p.box.params === "adapters");

  // One chip for what the drawing is doing; the long form is its accessible name.
  const status: { readonly chip: string; readonly name: string } = !clock
    ? { chip: "spec", name: "Specification of the configured model" }
    : reduced
      ? {
          chip: "static",
          name: "Reduced motion: static diagram, current phase highlighted",
        }
      : held
        ? { chip: "held", name: `Held at step ${fmtStep(executing)}; training continues` }
        : !running
          ? { chip: "paused", name: `Training paused at step ${fmtStep(executing)}` }
          : replaying
            ? {
                chip: `replay · ${Math.round(replayMs / 1000)} s`,
                name: `Replay of step ${fmtStep(executing)}`,
              }
            : fast
              ? {
                  chip: `${speed}× · occupancy`,
                  name: `${speed}× replay, ${formatSeconds(wallStep)} per step: every path shown with its traffic`,
                }
              : {
                  chip: speed === 1 ? "live · 1×" : `live · ${speed}×`,
                  name: "Following the run",
                };

  return (
    <figure
      ref={figure}
      className={css.figure}
      aria-label={figureLabel}
      aria-describedby={describedBy}
      data-motion={moving}
      data-mode={clock ? mode : undefined}
    >
      <p id={describedBy} className="srOnly">
        {spec.description}
      </p>
      <header className={css.head}>
        <div>
          <span className={css.caption}>{spec.figure}</span>
          <h3>{spec.heading}</h3>
        </div>
        <div className={css.actions}>
          <button
            type="button"
            onClick={() => {
              if (!context) return;
              setReplay({ startedAt: Date.now(), step: Math.min(total, completed + 1) });
              setHeldAt(null);
            }}
            disabled={reduced || !clock}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.6-3.7 M13 2.5v3h-3" />
            </svg>
            Replay
          </button>
          <button
            type="button"
            aria-pressed={!held}
            onClick={() => setHeldAt(held ? null : ticking)}
            disabled={reduced || !clock}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {held ? <path d="M5 3l8 5-8 5z" /> : <path d="M5 3v10 M11 3v10" />}
            </svg>
            {held ? "Play" : "Pause"}
          </button>
        </div>
      </header>

      {clock && moment && segment && (
        <div className={css.live} aria-live="off">
          <div className={css.readout}>
            <i style={{ background: PHASE_COLOUR[segment.phase] }} aria-hidden="true" />
            {mode === "occupancy" ? (
              <strong>occupancy</strong>
            ) : (
              <strong>{phaseText}</strong>
            )}
            {mode !== "occupancy" && (
              <span className={css.readoutTime}>
                {formatSeconds(moment.elapsed)}{" "}
                <small>of {formatSeconds(moment.total)}</small>
              </span>
            )}
            <span className={css.readoutStep}>
              step {fmtStep(executing)} <small>/ {fmtStep(total)}</small>
            </span>
          </div>
          <div className={css.timeline} aria-hidden="true">
            {segments.map((item, index) => (
              <span
                key={index}
                data-state={
                  mode === "occupancy"
                    ? "done"
                    : index < moment.index
                      ? "done"
                      : index === moment.index
                        ? "active"
                        : "pending"
                }
                style={{
                  flexGrow: Math.max(item.seconds, moment.total * 0.002),
                  background: PHASE_COLOUR[item.phase],
                }}
              />
            ))}
            {mode !== "occupancy" && (
              <b
                style={{
                  left: `${(moment.elapsed / Math.max(1e-9, moment.total)) * 100}%`,
                }}
              />
            )}
          </div>
        </div>
      )}

      <ul className={css.legend} aria-label="Figure legend">
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <path className={css.swatchForward} d="M0 6.5H16" />
            <circle className={css.swatchForwardDot} cx="17" cy="6.5" r="3.5" />
          </svg>
          forward
        </li>
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <path className={css.swatchGradient} d="M22 3.5H0" strokeWidth="1.2" />
            <path className={css.swatchGradient} d="M22 9.5H0" strokeWidth="3.4" />
          </svg>
          ∇ · width ‖g‖
        </li>
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <rect className={css.swatchBox} x="4" y="3" width="14" height="7" rx="1.5" />
            <rect
              className={css.swatchUpdate}
              x="0.5"
              y="0.5"
              width="21"
              height="12"
              rx="2.5"
            />
          </svg>
          update
        </li>
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <rect className={css.swatchBox} x="0.5" y="0.5" width="21" height="12" rx="2" />
            <rect className={css.hatch} x="0.5" y="0.5" width="21" height="12" rx="2" />
          </svg>
          frozen
        </li>
        {hasAdapters && (
          <li>
            <svg viewBox="0 0 22 13" aria-hidden="true">
              <rect
                className={css.swatchBox}
                x="0.5"
                y="0.5"
                width="21"
                height="12"
                rx="2"
              />
              <rect className={css.hatch} x="0.5" y="0.5" width="21" height="12" rx="2" />
              <rect className={css.adapters} x="4" y="7.5" width="14" height="3" />
            </svg>
            LoRA
          </li>
        )}
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <rect
              className={css.swatchBox}
              data-dashed
              x="0.5"
              y="0.5"
              width="21"
              height="12"
              rx="2"
            />
          </svg>
          absent
        </li>
        <li>
          <svg viewBox="0 0 22 13" aria-hidden="true">
            <path className={css.swatchLane} d="M0 3H22" strokeWidth="1" />
            <path className={css.swatchLane} d="M0 9H22" strokeWidth="4" />
          </svg>
          width = {rl ? "reward" : "loss"} share
        </li>
      </ul>

      <div
        className={css.canvas}
        tabIndex={0}
        role="region"
        aria-label={`${spec.figure} diagram`}
      >
        <svg
          className={css.svg}
          viewBox={`0 0 ${W} ${geo.height.toFixed(0)}`}
          role="img"
          aria-label={`${spec.heading} ${spec.sourcesTitle}: ${spec.sources.map((b) => b.title).join(", ")}. ${spec.modelTitle}: ${spec.model
            .flat()
            .map((b) => b.title)
            .join(
              ", ",
            )}. ${spec.headsTitle}: ${spec.heads.map((b) => b.title).join(", ")}. Then ${[spec.aggregate, ...spec.chain].map((b) => b.title).join(", ")}.${segment ? ` Now: step ${fmtStep(executing)}, ${phaseText}.` : ""}`}
        >
          <defs>
            <pattern id="arch-dots" width="14" height="14" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.9" className={css.dot} />
            </pattern>
            <pattern
              id="arch-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path d="M0 0V6" className={css.hatchLine} />
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

          <Wiring spec={spec} geo={geo} flow={flow} inset={inset} group={group} />

          {/* Weighted terms converge into the aggregate; each lane's width is its share. */}
          <g className={css.lanes}>
            {flow.lanes.map((lane) => {
              const term = byKey.get(lane.key);
              const share = term ? Math.abs(term.contribution) / magnitude : 0;
              return (
                <path
                  key={lane.id}
                  d={lane.d}
                  data-penalty={lane.penalty || undefined}
                  style={{ strokeWidth: clamp(1 + 10 * share, 1, 6.5) }}
                />
              );
            })}
          </g>

          {/* Moving marks run under the boxes: a box lights when the front reaches it. */}
          {scene && (
            <g className={css.flow}>
              {scene.lines.map((line, index) => (
                <path
                  key={index}
                  d={line.d}
                  data-style={line.style}
                  style={{
                    stroke: line.colour,
                    strokeWidth: line.width,
                    strokeDashoffset:
                      line.style === "grad" || line.style === "occupancyGrad"
                        ? dashOffset
                        : undefined,
                  }}
                />
              ))}
              {scene.particles.map((particle, index) => (
                <circle
                  key={`p${index}`}
                  className={css.particle}
                  cx={particle.at[0]}
                  cy={particle.at[1]}
                  r={2.4}
                  style={{ fill: particle.colour, opacity: particle.opacity }}
                />
              ))}
              {updateBox && checkpointBox && savePulse < 0.55 && (
                <circle
                  className={css.particle}
                  cx={
                    updateBox.x +
                    updateBox.w +
                    (checkpointBox.x - updateBox.x - updateBox.w) * (savePulse / 0.55)
                  }
                  cy={cy(checkpointBox)}
                  r={3.6}
                  style={{ fill: PHASE_COLOUR.optimizer }}
                />
              )}
              {scene.packets.slice(1).map((packet, index) => (
                <circle
                  key={index}
                  cx={packet.at[0]}
                  cy={packet.at[1]}
                  r={packet.grad ? 3.4 : 4.2}
                  data-grad={packet.grad || undefined}
                  style={packet.grad ? { stroke: packet.colour } : { fill: packet.colour }}
                />
              ))}
            </g>
          )}
          {clock && !reduced && (
            <circle
              className={css.packet}
              data-testid="reference-packet"
              data-grad={refPacket?.grad || undefined}
              cx={refPacket?.at[0] ?? cx(agg)}
              cy={refPacket?.at[1] ?? cy(agg)}
              r={refPacket ? (refPacket.grad ? 3.4 : 4.2) : 0}
              style={
                refPacket
                  ? refPacket.grad
                    ? { stroke: refPacket.colour }
                    : { fill: refPacket.colour }
                  : undefined
              }
            />
          )}

          <Boxes geo={geo} />

          {scene && (
            <g className={css.marks} aria-hidden="true">
              {[...scene.lit].map(([id, lit]) => {
                const p = flow.placed.get(id);
                if (!p) return null;
                return lit.kind === "adapters" ? (
                  <rect
                    key={id}
                    className={css.litAdapters}
                    x={p.x + 40}
                    y={p.y + BOX_H - 9}
                    width={p.w - 52}
                    height={4}
                    style={{ fill: lit.colour, opacity: lit.opacity }}
                  />
                ) : (
                  <rect
                    key={id}
                    className={css.lit}
                    x={p.x}
                    y={p.y}
                    width={p.w}
                    height={BOX_H}
                    rx={3}
                    style={{ stroke: lit.colour, opacity: lit.opacity }}
                  />
                );
              })}

              {scene.rings.map((ring) => {
                const p = flow.placed.get(ring.id);
                if (!p) return null;
                const d = 2 + 9 * ring.u;
                return ring.adapters ? (
                  <rect
                    key={`ring-${ring.id}`}
                    className={css.ring}
                    x={p.x + 40 - d}
                    y={p.y + BOX_H - 9 - d}
                    width={p.w - 52 + 2 * d}
                    height={4 + 2 * d}
                    rx={2}
                    style={{ stroke: PHASE_COLOUR.optimizer, opacity: 1 - ring.u }}
                  />
                ) : (
                  <rect
                    key={`ring-${ring.id}`}
                    className={css.ring}
                    x={p.x - d}
                    y={p.y - d}
                    width={p.w + 2 * d}
                    height={BOX_H + 2 * d}
                    rx={3 + d / 2}
                    style={{ stroke: PHASE_COLOUR.optimizer, opacity: 1 - ring.u }}
                  />
                );
              })}
              {checkpointBox && savePulse >= 0.55 && savePulse < 1 && (
                <rect
                  className={css.ring}
                  x={checkpointBox.x - (2 + (9 * (savePulse - 0.55)) / 0.45)}
                  y={checkpointBox.y - (2 + (9 * (savePulse - 0.55)) / 0.45)}
                  width={checkpointBox.w + 2 * (2 + (9 * (savePulse - 0.55)) / 0.45)}
                  height={BOX_H + 2 * (2 + (9 * (savePulse - 0.55)) / 0.45)}
                  rx={4}
                  style={{
                    stroke: PHASE_COLOUR.optimizer,
                    opacity: 1 - (savePulse - 0.55) / 0.45,
                  }}
                />
              )}

              {flow.fan && (
                <g className={css.fan} style={{ stroke: PHASE_COLOUR.gen }}>
                  {flow.fan.tips.map((tip, k) => {
                    const length = scene.rays[k] ?? 0;
                    if (length <= 0) return null;
                    const [ox, oy] = flow.fan!.origin;
                    return (
                      <g key={k}>
                        <path
                          d={`M${ox},${oy} L${ox + (tip[0] - ox) * length},${oy + (tip[1] - oy) * length}`}
                        />
                        {length >= 1 && (
                          <circle
                            cx={tip[0]}
                            cy={tip[1]}
                            r={1.8}
                            style={{ fill: PHASE_COLOUR.gen }}
                          />
                        )}
                      </g>
                    );
                  })}
                </g>
              )}

              {flow.reduceScatter && scene.reduceScatter !== undefined && (
                <g
                  transform={`translate(${flow.reduceScatter[0]} ${flow.reduceScatter[1]})`}
                >
                  <path
                    className={css.rsLit}
                    style={{ stroke: PHASE_COLOUR.comm }}
                    d="M-14,-10 L10,0 M-14,-3.3 L10,0 M-14,3.3 L10,0 M-14,10 L10,0"
                  />
                  <rect className={css.rsTrack} x={-16} y={16} width={32} height={3} />
                  <rect
                    x={-16}
                    y={16}
                    width={32 * scene.reduceScatter}
                    height={3}
                    style={{ fill: PHASE_COLOUR.comm }}
                  />
                  <text className={css.rsLabel} x={0} y={-16}>
                    reduce-scatter
                  </text>
                </g>
              )}

              {(inset === "ntp" || inset === "masked") && (
                <SequenceInset
                  geo={geo}
                  kind={inset}
                  lit={scene.tokens}
                  grad={scene.tokenGrad}
                  gradWidth={grad?.width ?? 1}
                  losses={sequenceLosses}
                  value={sequenceValue}
                />
              )}
              {inset === "rollout" && (
                <RolloutInset
                  geo={geo}
                  group={group}
                  gen={scene.gen}
                  lengths={rolloutLengths}
                  rewards={rewards}
                  verified={scene.verified}
                  advantages={advantages}
                  advantagesShown={scene.advantages}
                  grad={scene.tokenGrad}
                  gradWidth={grad?.width ?? 1}
                />
              )}
              {inset === "transfer" && (
                <TransferInset
                  geo={geo}
                  pair={transfer}
                  teacher={scene.teacher}
                  student={scene.student}
                  grad={scene.tokenGrad}
                  gradWidth={grad?.width ?? 1}
                />
              )}
            </g>
          )}

          {/* Live readouts: per-term contributions, the aggregate, the update chain. */}
          {terms && (
            <g className={css.values}>
              {geo.right.map((p) => {
                const term = p.box.lossKey ? byKey.get(p.box.lossKey) : undefined;
                if (!term) return null;
                return (
                  <g key={p.box.id} transform={`translate(${p.x} ${p.y})`}>
                    <text className={css.term} x={p.w - 10} y={41}>
                      {term.contribution < 0 ? "−" : ""}
                      {fmtTerm(Math.abs(term.contribution))}
                    </text>
                    <rect
                      className={css.termTrack}
                      x={40}
                      y={BOX_H - 6}
                      width={p.w - 52}
                      height={2}
                    />
                    <rect
                      className={css.termBar}
                      data-penalty={term.contribution < 0 || undefined}
                      x={40}
                      y={BOX_H - 6}
                      width={((p.w - 52) * Math.abs(term.contribution)) / maxTerm}
                      height={2}
                    />
                  </g>
                );
              })}
              {rl ? (
                <g transform={`translate(${agg.x + agg.w - 118} ${cy(agg)})`}>
                  <path className={css.advBase} d="M0,0 H108" />
                  {advantages.map((value, k) => {
                    const h = clamp(value, -2, 2) * 10 * (scene ? scene.advantages : 1);
                    return (
                      <rect
                        key={k}
                        className={css.advBar}
                        data-lit={
                          scene && moment?.segment.phase === "adv" ? true : undefined
                        }
                        x={k * 13.5}
                        y={h >= 0 ? -h : 0}
                        width={9}
                        height={Math.max(0.6, Math.abs(h))}
                      />
                    );
                  })}
                </g>
              ) : (
                <text className={css.total} x={agg.x + agg.w - 12} y={cy(agg) + 7}>
                  {fmtTerm(terms.total)}
                </text>
              )}
            </g>
          )}

          {frame && clock && (
            <g className={css.values}>
              {geo.chain.map((p) => {
                const id = p.box.id;
                const right = p.x + p.w - 10;
                const gauges = (
                  <ChainGauges
                    key={`g-${id}`}
                    p={p}
                    grad={id === "backward" || id === "grpo" ? grad : undefined}
                    lr={
                      id === "optimizer" || id === "grpo"
                        ? { value: frame.lr, peak: stage?.run.learningRate ?? frame.lr }
                        : undefined
                    }
                  />
                );
                if (id === "backward" || id === "grpo") {
                  const parts = id === "grpo" ? 4 : microBatches;
                  const done = moment?.partsDone ?? 0;
                  const shown = Math.min(parts, 12);
                  return (
                    <g key={id}>
                      {gauges}
                      {id === "grpo" && (
                        <text className={css.counter} x={right} y={p.y + 24}>
                          #{fmtStep(executing)}
                        </text>
                      )}
                      {Array.from({ length: shown }, (_, k) => (
                        <rect
                          key={k}
                          className={css.pip}
                          data-done={k < Math.round((done / parts) * shown) || undefined}
                          x={right - (shown - k) * 7 + 2}
                          y={p.y + (id === "grpo" ? BOX_H - 12 : 15)}
                          width={5}
                          height={5}
                        />
                      ))}
                    </g>
                  );
                }
                if (id === "optimizer") {
                  return (
                    <g key={id}>
                      {gauges}
                      <text className={css.counter} x={right} y={p.y + 24}>
                        #{fmtStep(executing)}
                      </text>
                    </g>
                  );
                }
                if (id === "kl" && frame.rl) {
                  const share = klAlert ? clamp(frame.rl.klLoss / klAlert, 0, 1) : 0;
                  return (
                    <g key={id}>
                      <text className={css.counter} x={right} y={p.y + 24}>
                        {frame.rl.klLoss.toFixed(4)}
                      </text>
                      <rect
                        className={css.termTrack}
                        x={p.x + 40}
                        y={p.y + BOX_H - 6}
                        width={p.w - 52}
                        height={2}
                      />
                      <rect
                        className={css.termBar}
                        data-alert={share >= 1 || undefined}
                        x={p.x + 40}
                        y={p.y + BOX_H - 6}
                        width={(p.w - 52) * share}
                        height={2}
                      />
                      {scene?.reference !== undefined && (
                        <rect
                          x={p.x + 40}
                          y={p.y + BOX_H - 11}
                          width={(p.w - 52) * scene.reference}
                          height={2}
                          style={{ fill: PHASE_COLOUR.ref }}
                        />
                      )}
                    </g>
                  );
                }
                if (id === "checkpoint") {
                  const toNext = (completed % every) / every;
                  return (
                    <g key={id}>
                      <rect
                        className={css.termTrack}
                        x={p.x + 40}
                        y={p.y + BOX_H - 6}
                        width={p.w - 52}
                        height={2}
                      />
                      <rect
                        className={css.termBar}
                        x={p.x + 40}
                        y={p.y + BOX_H - 6}
                        width={(p.w - 52) * toNext}
                        height={2}
                      />
                      {saving && (
                        <rect
                          className={css.event}
                          x={p.x}
                          y={p.y}
                          width={p.w}
                          height={BOX_H}
                          rx={3}
                        />
                      )}
                      <path
                        className={css.evalMark}
                        data-on={evaluating || undefined}
                        d={`M${right - 4},${p.y + 6} l4,4 -4,4 -4,-4z`}
                      >
                        <title>Evaluation on held-out split</title>
                      </path>
                    </g>
                  );
                }
                if (id === "export" && evaluating) {
                  return (
                    <rect
                      key={id}
                      className={css.event}
                      x={p.x}
                      y={p.y}
                      width={p.w}
                      height={BOX_H}
                      rx={3}
                    />
                  );
                }
                return null;
              })}
              {frame.skipped && flow.placed.get("optimizer") && (
                <rect
                  className={css.skipped}
                  x={flow.placed.get("optimizer")!.x}
                  y={flow.placed.get("optimizer")!.y}
                  width={CHAIN_W}
                  height={BOX_H}
                  rx={3}
                >
                  <title>Non-finite gradient norm: optimizer step skipped</title>
                </rect>
              )}
            </g>
          )}
        </svg>
      </div>

      <footer className={css.foot}>
        <span className={css.chip} role="status" aria-label={status.name}>
          {status.chip}
        </span>
        <span
          className={css.chip}
          data-quiet
          aria-label={
            clock
              ? "Simulated telemetry: the same step frames as the run console"
              : "Specification of the configured model, not worker telemetry"
          }
        >
          {clock ? "simulated" : "spec"}
        </span>
      </footer>
    </figure>
  );
}
