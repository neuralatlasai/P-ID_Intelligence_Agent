/**
 * Live loop telemetry for one tag, shaped the way a control-system faceplate and historian
 * present it.
 *
 * The parameters are the ones an operator and an instrument engineer read together:
 *
 *   - PV, and for a control loop SP, OP and MODE (ISA-5.1 / ISA-101 faceplate convention).
 *   - LL / L / H / HH alarm limits, each with a priority, a deadband and an on-delay, run
 *     through a real alarm state machine so an event is raised and returns to normal the way
 *     ISA-18.2 describes, not wherever a line happens to cross a limit.
 *   - Calibrated range (LRV–URV) and the 4–20 mA loop current, with NAMUR NE 43 signal limits.
 *   - Data quality as an OPC UA status (Good / Uncertain / Bad).
 *   - Device health as a NAMUR NE 107 status signal.
 *   - Window statistics: min, max, mean, standard deviation, rate of change, time outside the
 *     normal band.
 *
 * The value is a deterministic function of absolute time, seeded per tag. So the trend
 * scrolls as the clock moves instead of redrawing one fixed shape, every viewer sees the
 * same value at the same moment, and nothing needs storing. All of it is simulated and is
 * labelled so wherever it is shown.
 */

import {
  hashString,
  type AssetRecord,
  type PlantRegister,
  type TelemetrySpec,
} from "./engineering";

/** Scan period of the simulated controller: a new PV every five seconds. */
export const SCAN_MS = 5_000;

export const WINDOWS = {
  "1H": { span: 3_600_000, points: 120 },
  "8H": { span: 28_800_000, points: 160 },
  "1D": { span: 86_400_000, points: 192 },
  "1W": { span: 604_800_000, points: 210 },
} as const;
export type Window = keyof typeof WINDOWS;

export type AlarmLevel = "LL" | "L" | "H" | "HH";
export type AlarmPriority = "High" | "Medium" | "Low";

export interface AlarmLimit {
  readonly level: AlarmLevel;
  readonly value: number;
  readonly priority: AlarmPriority;
  /** Engineering units the value must recover past before the alarm returns to normal. */
  readonly deadband: number;
  /** Seconds the limit must be exceeded before the alarm annunciates. */
  readonly onDelayS: number;
}

export interface AlarmEvent {
  readonly t: number;
  readonly level: AlarmLevel;
  readonly priority: AlarmPriority;
  readonly value: number;
  readonly state: "ACTIVE" | "RTN";
}

export type Quality = "Good" | "Uncertain_LastUsableValue" | "Bad_OutOfService";
export type Ne107 =
  "Good" | "Maintenance required" | "Out of specification" | "Function check" | "Failure";
export type LoopMode = "AUTO" | "CAS" | "MAN";

export interface Sample {
  readonly t: number;
  readonly pv: number;
  readonly sp?: number;
  readonly op?: number;
}

export interface Telemetry {
  readonly tag: string;
  readonly measurement: string;
  readonly unit: string;
  readonly normal: readonly [number, number];
  readonly range: readonly [number, number];
  readonly limits: readonly AlarmLimit[];
  readonly series: readonly Sample[];
  readonly current: Sample;
  readonly loop?:
    { readonly id: string; readonly valve: string; readonly mode: LoopMode } | undefined;
  readonly milliamps: number;
  readonly signal: "Normal" | "Saturated" | "Fault";
  readonly quality: Quality;
  readonly health: Ne107;
  readonly stats: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly sigma: number;
    /** Engineering units per minute over the last few scans. */
    readonly ratePerMin: number;
    /** Share of the window outside the normal band, 0–1. */
    readonly outsideNormal: number;
  };
  readonly events: readonly AlarmEvent[];
  readonly active: AlarmLimit | undefined;
}

/**
 * Deadband and on-delay by measured variable.
 *
 * These are the starting values commonly tabulated in alarm-management guidance built on
 * ISA-18.2 and EEMUA 191 — flow and level 5 % of span over 15 s and 60 s, pressure 2 % over
 * 15 s, temperature 1 % over 60 s — and are meant to be tuned per loop.
 */
const ALARM_TUNING: Record<
  string,
  { readonly deadbandPct: number; readonly delayS: number }
> = {
  Flow: { deadbandPct: 5, delayS: 15 },
  Level: { deadbandPct: 5, delayS: 60 },
  Pressure: { deadbandPct: 2, delayS: 15 },
  Temperature: { deadbandPct: 1, delayS: 60 },
};

// ── deterministic value noise ────────────────────────────────────────────────────────────────

function unit(seed: number, index: number): number {
  return (hashString(`${seed}:${index}`) / 4294967296) * 2 - 1;
}

/** Smooth noise in [-1, 1] at a given period: cosine-interpolated lattice values. */
function smooth(seed: number, t: number, period: number): number {
  const position = t / period;
  const index = Math.floor(position);
  const f = (1 - Math.cos((position - index) * Math.PI)) / 2;
  return unit(seed, index) * (1 - f) + unit(seed, index + 1) * f;
}

/** The PV at an absolute time. Multi-scale noise plus the occasional seeded excursion. */
function pvAt(spec: TelemetrySpec, t: number): number {
  const [low, high] = spec.normal;
  const mid = (low + high) / 2;
  const band = (high - low) / 2;
  const seed = spec.seed;
  let value =
    mid +
    band *
      (0.55 * smooth(seed, t, 6 * 3_600_000) +
        0.35 * smooth(seed ^ 0x9e37, t, 45 * 60_000) +
        0.2 * smooth(seed ^ 0x51ed, t, 4 * 60_000) +
        0.08 * smooth(seed ^ 0x2b79, t, SCAN_MS * 2));
  // Roughly one upset in eight per four-hour block: a smooth bump toward, and sometimes past, a limit.
  const block = Math.floor(t / (4 * 3_600_000));
  const roll = hashString(`${seed}#upset#${block}`) / 4294967296;
  if (roll < 0.125) {
    const centre = (block + 0.3 + roll * 3) * 4 * 3_600_000;
    const width = 25 * 60_000;
    const direction = roll < 0.07 ? 1 : -1;
    const reach = direction > 0 ? spec.alarmHigh - mid : mid - spec.alarmLow;
    value +=
      direction * reach * (0.75 + roll * 2) * Math.exp(-(((t - centre) / width) ** 2));
  }
  return value;
}

function round(value: number, span: number): number {
  const digits = span >= 100 ? 1 : span >= 10 ? 2 : 3;
  return Number(value.toFixed(digits));
}

/** Alarm limits for a spec: HH and LL from the register, H and L between them and the band. */
export function alarmLimits(spec: TelemetrySpec): readonly AlarmLimit[] {
  const variable = Object.keys(ALARM_TUNING).find((key) => spec.measurement.includes(key));
  const tuning = ALARM_TUNING[variable ?? ""] ?? { deadbandPct: 2, delayS: 30 };
  const span = spec.alarmHigh - spec.alarmLow;
  const deadband = round((span * tuning.deadbandPct) / 100, span);
  const h = spec.normal[1] + (spec.alarmHigh - spec.normal[1]) * 0.5;
  const l = spec.normal[0] - (spec.normal[0] - spec.alarmLow) * 0.5;
  return [
    {
      level: "HH",
      value: spec.alarmHigh,
      priority: "High",
      deadband,
      onDelayS: Math.max(5, tuning.delayS / 3),
    },
    {
      level: "H",
      value: round(h, span),
      priority: "Medium",
      deadband,
      onDelayS: tuning.delayS,
    },
    {
      level: "L",
      value: round(l, span),
      priority: "Medium",
      deadband,
      onDelayS: tuning.delayS,
    },
    {
      level: "LL",
      value: spec.alarmLow,
      priority: "High",
      deadband,
      onDelayS: Math.max(5, tuning.delayS / 3),
    },
  ];
}

/** The level a PV is beyond, most severe first; undefined inside L–H. */
function beyond(limits: readonly AlarmLimit[], pv: number): AlarmLimit | undefined {
  const [hh, h, l, ll] = limits as [AlarmLimit, AlarmLimit, AlarmLimit, AlarmLimit];
  if (pv >= hh.value) return hh;
  if (pv <= ll.value) return ll;
  if (pv >= h.value) return h;
  if (pv <= l.value) return l;
  return undefined;
}

/**
 * Run the ISA-18.2 alarm state machine over a series.
 *
 * An alarm activates when the PV has stayed beyond a limit for the on-delay, and returns to
 * normal only once it has recovered past the limit by the deadband. Escalation from H to HH
 * is a new event. O(n) in samples.
 */
export function alarmEvents(
  series: readonly Sample[],
  limits: readonly AlarmLimit[],
  stepMs: number,
): { readonly events: AlarmEvent[]; readonly active: AlarmLimit | undefined } {
  const events: AlarmEvent[] = [];
  let active: AlarmLimit | undefined;
  let pending: { limit: AlarmLimit; since: number } | undefined;
  for (const sample of series) {
    const over = beyond(limits, sample.pv);
    if (active) {
      const high = active.level.startsWith("H");
      const recovered = high
        ? sample.pv < active.value - active.deadband
        : sample.pv > active.value + active.deadband;
      const escalated =
        over &&
        over.priority === "High" &&
        active.priority !== "High" &&
        over.level[0] === active.level[0];
      if (escalated) {
        active = over;
        events.push({
          t: sample.t,
          level: over.level,
          priority: over.priority,
          value: sample.pv,
          state: "ACTIVE",
        });
      } else if (recovered) {
        events.push({
          t: sample.t,
          level: active.level,
          priority: active.priority,
          value: sample.pv,
          state: "RTN",
        });
        active = undefined;
      }
      continue;
    }
    if (!over) {
      pending = undefined;
      continue;
    }
    if (!pending || pending.limit.level !== over.level)
      pending = { limit: over, since: sample.t - stepMs };
    if (sample.t - pending.since >= over.onDelayS * 1000) {
      active = over;
      pending = undefined;
      events.push({
        t: sample.t,
        level: over.level,
        priority: over.priority,
        value: sample.pv,
        state: "ACTIVE",
      });
    }
  }
  return { events, active };
}

function loopOf(asset: AssetRecord, register: PlantRegister) {
  if (!asset.loop) return undefined;
  for (const other of register.assets.values()) {
    if (other.loop === asset.loop && other.category === "control-valve") return other;
  }
  return undefined;
}

/**
 * Everything the telemetry panel shows for one measuring tag, at `now`.
 *
 * O(points) for the series and the alarm pass; the window's point count is bounded.
 */
export function telemetryFor(
  asset: AssetRecord,
  register: PlantRegister,
  window: Window,
  now: number,
): Telemetry | undefined {
  const spec = asset.telemetry;
  if (!spec) return undefined;
  const { span, points } = WINDOWS[window];
  const step = span / points;
  const end = Math.floor(now / SCAN_MS) * SCAN_MS;
  const valve = loopOf(asset, register);
  const [low, high] = spec.normal;
  const mid = (low + high) / 2;
  const band = (high - low) / 2;
  const rangeTop = Math.ceil((spec.alarmHigh * 1.25) / 5) * 5;
  const range: [number, number] = [Math.min(0, Math.floor(spec.alarmLow)), rangeTop];
  const rangeSpan = range[1] - range[0];

  const sampleAt = (t: number): Sample => {
    const pv = round(pvAt(spec, t), rangeSpan);
    if (!valve) return { t, pv };
    // Setpoint moves rarely, in engineered steps; output is a PI-like response plus valve drift.
    const shift = Math.floor(t / (8 * 3_600_000));
    const sp = round(
      mid + (band * 0.2 * Math.round(unit(spec.seed ^ 0x5b, shift) * 2)) / 2,
      rangeSpan,
    );
    const error = (sp - pv) / (band || 1);
    const op = Math.min(
      100,
      Math.max(0, 52 + 28 * error + 6 * smooth(spec.seed ^ 0x77, t, 3 * 3_600_000)),
    );
    return { t, pv, sp, op: Number(op.toFixed(1)) };
  };

  const series: Sample[] = [];
  for (let index = points - 1; index >= 1; index -= 1)
    series.push(sampleAt(Math.floor((end - index * step) / SCAN_MS) * SCAN_MS));
  const current = sampleAt(end);
  series.push(current);

  const limits = alarmLimits(spec);
  const { events, active } = alarmEvents(series, limits, step);

  const values = series.map((s) => s.pv);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const sigma = Math.sqrt(
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length,
  );
  const previous = sampleAt(end - 12 * SCAN_MS);
  const outside = values.filter((v) => v < low || v > high).length / values.length;

  const milliamps = 4 + (16 * (current.pv - range[0])) / rangeSpan;
  const status = asset.status;
  const quality: Quality =
    status === "Under maintenance"
      ? "Bad_OutOfService"
      : status === "Standby"
        ? "Uncertain_LastUsableValue"
        : "Good";
  const drift = asset.failureModes.find(
    (f) => ["PDE", "AIR", "ERO"].includes(f.code) && f.likelihood === "High",
  );
  const health: Ne107 =
    status === "Under maintenance"
      ? "Function check"
      : milliamps > 20.5 || milliamps < 3.8
        ? "Out of specification"
        : drift
          ? "Maintenance required"
          : "Good";

  return {
    tag: asset.tag,
    measurement: spec.measurement,
    unit: spec.unit,
    normal: spec.normal,
    range,
    limits,
    series,
    current,
    loop:
      valve && asset.loop
        ? { id: asset.loop, valve: valve.tag, mode: status === "Standby" ? "MAN" : "AUTO" }
        : undefined,
    milliamps: Number(milliamps.toFixed(2)),
    // NAMUR NE 43: 3.8–20.5 mA measurement range; ≤3.6 or ≥21.0 mA signals a fault.
    signal:
      milliamps <= 3.6 || milliamps >= 21
        ? "Fault"
        : milliamps < 3.8 || milliamps > 20.5
          ? "Saturated"
          : "Normal",
    quality,
    health,
    stats: {
      min: Math.min(...values),
      max: Math.max(...values),
      mean,
      sigma,
      ratePerMin: (current.pv - previous.pv) / ((12 * SCAN_MS) / 60_000),
      outsideNormal: outside,
    },
    events,
    active,
  };
}
