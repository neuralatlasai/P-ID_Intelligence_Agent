import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import {
  alarmEvents,
  alarmLimits,
  SCAN_MS,
  telemetryFor,
  WINDOWS,
  type Sample,
} from "@/lib/canvas/telemetry";

/**
 * The telemetry is simulated, so what is worth pinning is that it behaves like the real
 * thing: limits are ordered, alarms respect deadband and on-delay, the trend moves with the
 * clock, and the loop current agrees with the PV.
 */

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(drawing, adjacency, NOW);
const transmitter = [...register.assets.values()].find(
  (a) => a.category === "instrument" && a.loop && a.telemetry,
)!;

describe("alarmLimits", () => {
  it("orders LL < L < normal < H < HH, with High priority on the outer pair", () => {
    const spec = transmitter.telemetry!;
    const [hh, h, l, ll] = alarmLimits(spec);
    expect(ll!.value).toBeLessThan(l!.value);
    expect(l!.value).toBeLessThan(spec.normal[0]);
    expect(h!.value).toBeGreaterThan(spec.normal[1]);
    expect(hh!.value).toBeGreaterThan(h!.value);
    expect([hh!.priority, ll!.priority]).toEqual(["High", "High"]);
    expect(h!.deadband).toBeGreaterThan(0);
  });
});

describe("alarmEvents", () => {
  const limits = [
    { level: "HH", value: 20, priority: "High", deadband: 1, onDelayS: 10 },
    { level: "H", value: 15, priority: "Medium", deadband: 1, onDelayS: 10 },
    { level: "L", value: 5, priority: "Medium", deadband: 1, onDelayS: 10 },
    { level: "LL", value: 0, priority: "High", deadband: 1, onDelayS: 10 },
  ] as const;
  const run = (values: number[]) =>
    alarmEvents(
      values.map((pv, i): Sample => ({ t: i * 5_000, pv })),
      limits,
      5_000,
    );

  it("ignores an excursion shorter than the on-delay", () => {
    expect(run([10, 16, 10, 10]).events).toEqual([]);
  });

  it("activates after the on-delay and returns only past the deadband", () => {
    const { events, active } = run([10, 16, 16, 14.5, 13.9]);
    expect(events.map((e) => `${e.level} ${e.state}`)).toEqual(["H ACTIVE", "H RTN"]);
    expect(events[1]!.value).toBe(13.9);
    expect(active).toBeUndefined();
  });

  it("escalates H to HH as a new event", () => {
    const { events, active } = run([16, 16, 21]);
    expect(events.map((e) => e.level)).toEqual(["H", "HH"]);
    expect(active?.level).toBe("HH");
  });
});

describe("telemetryFor", () => {
  it("moves with the clock, one scan at a time", () => {
    const a = telemetryFor(transmitter, register, "1H", NOW)!;
    const b = telemetryFor(transmitter, register, "1H", NOW + SCAN_MS)!;
    expect(b.current.t - a.current.t).toBe(SCAN_MS);
    expect(a.series).toHaveLength(WINDOWS["1H"].points);
    expect(telemetryFor(transmitter, register, "1H", NOW)).toEqual(a);
  });

  it("reports loop current consistent with PV and range, and loop pens for a loop", () => {
    const t = telemetryFor(transmitter, register, "8H", NOW)!;
    const expected = 4 + (16 * (t.current.pv - t.range[0])) / (t.range[1] - t.range[0]);
    expect(t.milliamps).toBeCloseTo(expected, 1);
    expect(t.loop?.valve).toMatch(/CV-\d+$/);
    expect(t.current.sp).toBeDefined();
    expect(t.current.op).toBeGreaterThanOrEqual(0);
    expect(t.current.op).toBeLessThanOrEqual(100);
    expect(t.stats.min).toBeLessThanOrEqual(t.stats.mean);
    expect(t.stats.max).toBeGreaterThanOrEqual(t.stats.mean);
  });
});
