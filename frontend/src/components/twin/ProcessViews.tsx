"use client";

import { useId, useState, type ReactNode } from "react";

import { SimulatedBadge } from "@/components/canvas/AssetPanels";
import type { AssetRecord, PlantRegister } from "@/lib/canvas/engineering";
import {
  equalPercentageGainPct,
  equalPercentageKv,
  gateOpenFraction,
  gateTurns,
  laggedReadingC,
  liquidFlowM3h,
  loopCurrentMa,
  magmeterFlowM3h,
  pt100Ohms,
  radarState,
  vesselState,
  vesselVolume,
  type ControlValveBasis,
  type GateValveBasis,
  type MagmeterBasis,
  type ProcessSpec,
  type RadarBasis,
  type TemperatureBasis,
  type VesselBasis,
} from "@/lib/twin/process";

import styles from "./DigitalTwin.module.css";

/**
 * The process view for every asset class except the exchanger, which keeps its ε-NTU
 * simulation. Each is deliberately small: one relation, one chart, three read-outs, and the
 * assumed basis written underneath in full, because an unlabelled number next to a
 * photograph reads as a measurement.
 */

const format = (value: number, digits: number) =>
  value.toLocaleString("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

// ────────────────────────────────────────────────────────────────────────────────────────────
// Chart
// ────────────────────────────────────────────────────────────────────────────────────────────

interface Curve {
  readonly points: readonly (readonly [number, number])[];
  /** A reference curve is dashed and quieter than the series it is compared with. */
  readonly reference?: boolean;
}

/**
 * A single-series XY chart in the application's chart grammar: `--series-1` for the curve,
 * `--rule-strong` dashed for a reference, a shaded band for the normal range, and a marked
 * operating point with a crosshair.
 */
function CurveChart({
  curves,
  x,
  y,
  marker,
  band,
  zones = [],
  label,
}: {
  readonly curves: readonly Curve[];
  readonly x: {
    readonly domain: readonly [number, number];
    readonly ticks: readonly number[];
    readonly unit: string;
  };
  readonly y: {
    readonly domain: readonly [number, number];
    readonly ticks: readonly number[];
    readonly unit: string;
  };
  readonly marker?: readonly [number, number];
  /** A horizontal band on y (normal operating range). */
  readonly band?: readonly [number, number];
  /** Vertical zones on x that the view calls out (alarm regions, a blocking zone). */
  readonly zones?: readonly (readonly [number, number])[];
  readonly label: string;
}) {
  const W = 360;
  const H = 168;
  const left = 40;
  const right = 10;
  const top = 10;
  const bottom = 30;
  const px = (v: number) =>
    left + ((v - x.domain[0]) / (x.domain[1] - x.domain[0])) * (W - left - right);
  const py = (v: number) =>
    top + (1 - (v - y.domain[0]) / (y.domain[1] - y.domain[0])) * (H - top - bottom);
  const path = (points: Curve["points"]) =>
    points
      .map(([a, b], i) => `${i ? "L" : "M"}${px(a).toFixed(1)},${py(b).toFixed(1)}`)
      .join("");

  return (
    <svg
      className={styles.processChart}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
    >
      {band && (
        <rect
          x={left}
          y={py(band[1])}
          width={W - left - right}
          height={Math.max(0, py(band[0]) - py(band[1]))}
          fill="var(--status-ready-bg)"
        />
      )}
      {zones.map(([from, to]) => (
        <rect
          key={`${from}-${to}`}
          x={px(from)}
          y={top}
          width={Math.max(0, px(to) - px(from))}
          height={H - top - bottom}
          fill="var(--status-degraded-bg)"
        />
      ))}
      {x.ticks.map((t) => (
        <g key={`x${t}`}>
          <line x1={px(t)} x2={px(t)} y1={top} y2={H - bottom} stroke="var(--chart-grid)" />
          <text x={px(t)} y={H - bottom + 13} textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      {y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line x1={left} x2={W - right} y1={py(t)} y2={py(t)} stroke="var(--chart-grid)" />
          <text x={left - 5} y={py(t) + 3.5} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <line
        x1={left}
        x2={W - right}
        y1={H - bottom}
        y2={H - bottom}
        stroke="var(--chart-axis)"
      />
      <line x1={left} x2={left} y1={top} y2={H - bottom} stroke="var(--chart-axis)" />
      <text x={W - right} y={H - 3} textAnchor="end">
        {x.unit}
      </text>
      <text x={4} y={top + 2} textAnchor="start" dominantBaseline="hanging">
        {y.unit}
      </text>
      {curves.map((curve, index) => (
        <path
          key={index}
          d={path(curve.points)}
          fill="none"
          stroke={curve.reference ? "var(--rule-strong)" : "var(--series-1)"}
          strokeDasharray={curve.reference ? "4 4" : undefined}
          strokeWidth={curve.reference ? 1.2 : 2}
        />
      ))}
      {marker && (
        <g>
          <line
            x1={px(marker[0])}
            x2={px(marker[0])}
            y1={top}
            y2={H - bottom}
            stroke="var(--chart-crosshair)"
          />
          <circle
            cx={px(marker[0])}
            cy={py(marker[1])}
            r={4}
            fill="var(--bg-surface)"
            stroke="var(--series-1)"
            strokeWidth={2}
          />
        </g>
      )}
    </svg>
  );
}

const sample = (from: number, to: number, count: number, f: (v: number) => number) =>
  Array.from({ length: count + 1 }, (_, i) => {
    const v = from + ((to - from) * i) / count;
    return [v, f(v)] as const;
  });

// ────────────────────────────────────────────────────────────────────────────────────────────
// Shared chrome
// ────────────────────────────────────────────────────────────────────────────────────────────

function Slider({
  label,
  unit,
  value,
  min,
  max,
  step,
  digits,
  onChange,
}: {
  readonly label: string;
  readonly unit: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly digits: number;
  readonly onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className={styles.slider}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id}>
        {format(value, digits)} <span>{unit}</span>
      </output>
    </div>
  );
}

interface Stat {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  /** Marks a read-out outside its band — state the view has determined. */
  readonly off?: boolean;
  readonly note?: string;
}

function Stats({ stats }: { readonly stats: readonly Stat[] }) {
  return (
    <dl className={styles.stats}>
      {stats.map((stat) => (
        <div key={stat.label} className={styles.stat} data-off={stat.off || undefined}>
          <dt>{stat.label}</dt>
          <dd>
            <strong>{stat.value}</strong> <span>{stat.unit}</span>
          </dd>
          {stat.note && <dd className={styles.statNote}>{stat.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Frame({
  title,
  children,
  basis,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly basis: string;
}) {
  return (
    <section className={styles.card} aria-label="Process view">
      <header>
        <h3>{title}</h3>
        <SimulatedBadge />
      </header>
      <div className={styles.process}>{children}</div>
      <p className={styles.basis}>
        <b>Assumed basis</b> {basis}
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Per class
// ────────────────────────────────────────────────────────────────────────────────────────────

function VesselView({ basis }: { readonly basis: VesselBasis }) {
  const [level, setLevel] = useState(50);
  const [imbalance, setImbalance] = useState(0);
  const state = vesselState(basis, level, imbalance);
  const full = vesselVolume(basis, basis.spanM);
  const top = Math.ceil(full);
  const off = level < basis.alarmLowPct || level > basis.alarmHighPct;
  return (
    <Frame
      title="Process view · holdup and head"
      basis={`ID ${format(basis.idM, 1)} m, T/T ${format(basis.tangentM, 1)} m, 2:1 semi-elliptical heads; level span ${format(basis.spanM, 1)} m from the bottom of the lower head; ${basis.fluid}, ρ ${basis.densityKgM3} kg/m³; design liquid outflow ${basis.outflowM3h} m³/h. Alarms at the register's ${basis.alarmLowPct} % and ${basis.alarmHighPct} %.`}
    >
      <Slider
        label="Level"
        unit="%"
        value={level}
        min={0}
        max={100}
        step={1}
        digits={0}
        onChange={setLevel}
      />
      <Slider
        label="Inflow − outflow"
        unit="m³/h"
        value={imbalance}
        min={-basis.outflowM3h}
        max={basis.outflowM3h}
        step={basis.outflowM3h / 20}
        digits={1}
        onChange={setImbalance}
      />
      <CurveChart
        label={`Liquid holdup against level: ${format(state.holdupM3, 2)} m³ at ${level} %; alarm regions below ${basis.alarmLowPct} % and above ${basis.alarmHighPct} % shaded.`}
        curves={[
          {
            points: sample(0, 100, 60, (p) => vesselVolume(basis, (p / 100) * basis.spanM)),
          },
        ]}
        x={{ domain: [0, 100], ticks: [0, 25, 50, 75, 100], unit: "level %" }}
        y={{ domain: [0, top], ticks: [0, top / 2, top], unit: "m³" }}
        marker={[level, state.holdupM3]}
        zones={[
          [0, basis.alarmLowPct],
          [basis.alarmHighPct, 100],
        ]}
      />
      <Stats
        stats={[
          { label: "Holdup", value: format(state.holdupM3, 2), unit: "m³", off },
          { label: "Bottom nozzle", value: format(state.bottomBarg, 2), unit: "barg" },
          state.toward
            ? {
                label: state.toward === "high" ? "To high alarm" : "To low alarm",
                value: state.toAlarmMin === undefined ? "—" : format(state.toAlarmMin, 0),
                unit: "min",
                off: state.toAlarmMin === undefined || state.toAlarmMin < 10,
                note: state.toAlarmMin === undefined ? "Already past it" : undefined,
              }
            : { label: "Residence", value: format(state.residenceMin, 0), unit: "min" },
        ]}
      />
    </Frame>
  );
}

function ControlValveView({
  basis,
  anchor,
  register,
  tagOf,
}: {
  readonly basis: ControlValveBasis;
  readonly anchor: AssetRecord;
  readonly register: PlantRegister;
  readonly tagOf: (nodeId: string) => string | undefined;
}) {
  const [travel, setTravel] = useState(50);
  const [dp, setDp] = useState(basis.dpBar);
  const kv = equalPercentageKv(basis, travel / 100);
  const flow = liquidFlowM3h(kv, dp, basis.sg);
  const maxFlow = liquidFlowM3h(basis.kvs, dp, basis.sg);
  const partner = [...register.assets.values()].find(
    (asset) =>
      asset.loop !== undefined &&
      asset.loop === anchor.loop &&
      asset.nodeId !== anchor.nodeId &&
      asset.category === "instrument",
  );
  const yTop = Math.ceil(liquidFlowM3h(basis.kvs, 6, basis.sg) / 100) * 100;
  return (
    <Frame
      title="Process view · inherent characteristic"
      basis={`Equal-percentage trim, Kvs ${basis.kvs} m³/h, rangeability ${basis.rangeability}:1; flow is water-equivalent (SG ${basis.sg}) at constant ΔP, non-choked, per the IEC 60534 liquid equation. Steam service would need the compressible equation; the Kv curve itself holds for any fluid.`}
    >
      {partner && (
        <p className={styles.processNote}>
          Final element of loop <code>{anchor.loop}</code> with{" "}
          <code>{tagOf(partner.nodeId) ?? partner.tag}</code> {partner.name.toLowerCase()}.
        </p>
      )}
      <Slider
        label="Travel"
        unit="%"
        value={travel}
        min={0}
        max={100}
        step={1}
        digits={0}
        onChange={setTravel}
      />
      <Slider
        label="ΔP across valve"
        unit="bar"
        value={dp}
        min={0.2}
        max={6}
        step={0.1}
        digits={1}
        onChange={setDp}
      />
      <CurveChart
        label={`Flow against travel at ${format(dp, 1)} bar: ${format(flow, 0)} m³/h at ${travel} % travel; dashed line is a linear trim for comparison.`}
        curves={[
          { points: sample(0, 100, 50, (p) => (p / 100) * maxFlow), reference: true },
          {
            points: sample(0, 100, 80, (p) =>
              liquidFlowM3h(equalPercentageKv(basis, p / 100), dp, basis.sg),
            ),
          },
        ]}
        x={{ domain: [0, 100], ticks: [0, 25, 50, 75, 100], unit: "travel %" }}
        y={{ domain: [0, yTop], ticks: [0, yTop / 2, yTop], unit: "m³/h" }}
        marker={[travel, flow]}
      />
      <Stats
        stats={[
          { label: "Kv", value: format(kv, 1), unit: "m³/h" },
          { label: "Flow", value: format(flow, 0), unit: "m³/h" },
          {
            label: "Gain",
            value: format(equalPercentageGainPct(basis), 1),
            unit: "% flow / % travel",
            note: "Of current flow, at any travel",
          },
        ]}
      />
    </Frame>
  );
}

function GateValveView({ basis }: { readonly basis: GateValveBasis }) {
  const [travel, setTravel] = useState(100);
  const open = gateOpenFraction(travel / 100);
  const turns = gateTurns(basis, travel / 100);
  const total = gateTurns(basis, 1);
  const areaCm2 = (Math.PI * (basis.portMm / 10) ** 2) / 4;
  const throttling = travel > 0 && travel < 100;
  return (
    <Frame
      title="Process view · port area and stroke"
      basis={`Round port DN${basis.portMm} (${format(areaCm2, 0)} cm²), flat gate; rising stem, ${basis.leadMm} mm of stem per handwheel turn. Area is geometric, not a flow characteristic.`}
    >
      <Slider
        label="Stem travel"
        unit="% open"
        value={travel}
        min={0}
        max={100}
        step={1}
        digits={0}
        onChange={setTravel}
      />
      <CurveChart
        label={`Open port area against stem travel: ${format(open * 100, 0)} % of the port at ${travel} % travel.`}
        curves={[
          { points: sample(0, 100, 50, (p) => p), reference: true },
          { points: sample(0, 100, 80, (p) => gateOpenFraction(p / 100) * 100) },
        ]}
        x={{ domain: [0, 100], ticks: [0, 25, 50, 75, 100], unit: "travel %" }}
        y={{ domain: [0, 100], ticks: [0, 50, 100], unit: "area %" }}
        marker={[travel, open * 100]}
      />
      <Stats
        stats={[
          { label: "Open area", value: format(open * areaCm2, 0), unit: "cm²" },
          {
            label: "Turns from closed",
            value: format(turns, 1),
            unit: `of ${format(total, 0)}`,
          },
          {
            label: "Duty",
            value: travel === 0 ? "Closed" : travel === 100 ? "Open" : "Throttling",
            unit: "",
            off: throttling,
            note: throttling ? "Erodes wedge and seats" : undefined,
          },
        ]}
      />
    </Frame>
  );
}

function FlowmeterView({
  basis,
  anchor,
  register,
}: {
  readonly basis: MagmeterBasis;
  readonly anchor: AssetRecord;
  readonly register: PlantRegister;
}) {
  const band = anchor.telemetry?.normal;
  const [velocity, setVelocity] = useState(() => {
    const mid = band ? (band[0] + band[1]) / 2 : basis.urvM3h / 2;
    return Math.round((mid / magmeterFlowM3h(basis, 1)) * 10) / 10;
  });
  const flow = magmeterFlowM3h(basis, velocity);
  const ma = loopCurrentMa(flow, 0, basis.urvM3h);
  const line = anchor.lines[0] ? register.lines.get(anchor.lines[0]) : undefined;
  const inWindow = velocity >= basis.velocityMin && velocity <= basis.velocityMax;
  const yTop = Math.ceil(magmeterFlowM3h(basis, basis.velocityMax) / 50) * 50;
  return (
    <Frame
      title="Process view · velocity to volumetric flow"
      basis={`Bore ${format(basis.boreM * 1000, 1)} mm (DN80${line ? `, on ${line.number}` : ""}); Q = v·πD²/4. Output 4–20 mA over 0–${basis.urvM3h} m³/h. Specified velocity ${basis.velocityMin}–${basis.velocityMax} m/s. Requires a conductive liquid.`}
    >
      <Slider
        label="Mean velocity"
        unit="m/s"
        value={velocity}
        min={0}
        max={basis.velocityMax}
        step={0.1}
        digits={1}
        onChange={setVelocity}
      />
      <CurveChart
        label={`Volumetric flow against mean velocity: ${format(flow, 1)} m³/h at ${format(velocity, 1)} m/s${band ? `; register normal band ${band[0]}–${band[1]} m³/h shaded` : ""}.`}
        curves={[
          { points: sample(0, basis.velocityMax, 20, (v) => magmeterFlowM3h(basis, v)) },
        ]}
        x={{ domain: [0, basis.velocityMax], ticks: [0, 2, 4, 6, 8, 10], unit: "m/s" }}
        y={{ domain: [0, yTop], ticks: [0, yTop / 2, yTop], unit: "m³/h" }}
        band={band}
        zones={[[0, basis.velocityMin]]}
        marker={[velocity, flow]}
      />
      <Stats
        stats={[
          {
            label: "Flow",
            value: format(flow, 1),
            unit: "m³/h",
            off: band ? flow < band[0] || flow > band[1] : false,
          },
          { label: "Output", value: format(ma, 2), unit: "mA" },
          {
            label: "Velocity",
            value: format(velocity, 1),
            unit: "m/s",
            off: !inWindow,
            note: inWindow ? undefined : "Below the specified window",
          },
        ]}
      />
    </Frame>
  );
}

function RadarView({ basis }: { readonly basis: RadarBasis }) {
  const [level, setLevel] = useState(5);
  const state = radarState(basis, level);
  const blockedFrom = basis.referenceM - basis.blockingM;
  return (
    <Frame
      title="Process view · reading against true level"
      basis={`Reference (flange face) ${basis.referenceM} m above the vessel bottom; blocking distance ${basis.blockingM} m below the antenna; 4–20 mA over ${basis.lrvM}–${basis.urvM} m. Vessel not identified on the drawing, so its height is assumed.`}
    >
      <Slider
        label="True level"
        unit="m"
        value={level}
        min={0}
        max={basis.referenceM}
        step={0.05}
        digits={2}
        onChange={setLevel}
      />
      <CurveChart
        label={`Transmitter reading against true level. Readings are valid up to ${format(blockedFrom, 1)} m; above that the surface is inside the blocking distance.${state.readingM === undefined ? " Current level is inside the blocking distance." : ""}`}
        curves={[
          { points: sample(0, basis.referenceM, 10, (v) => v), reference: true },
          { points: sample(0, blockedFrom, 20, (v) => radarState(basis, v).readingM ?? v) },
        ]}
        x={{ domain: [0, basis.referenceM], ticks: [0, 2, 4, 6, 8, 10], unit: "true m" }}
        y={{ domain: [0, basis.referenceM], ticks: [0, 5, 10], unit: "read m" }}
        zones={[[blockedFrom, basis.referenceM]]}
        marker={[level, state.readingM ?? blockedFrom]}
      />
      <Stats
        stats={[
          { label: "To surface", value: format(state.distanceM, 2), unit: "m" },
          { label: "Echo round trip", value: format(state.roundTripNs, 1), unit: "ns" },
          state.currentMa === undefined
            ? {
                label: "Output",
                value: "Invalid",
                unit: "",
                off: true,
                note: "Inside blocking distance",
              }
            : { label: "Output", value: format(state.currentMa, 2), unit: "mA" },
        ]}
      />
    </Frame>
  );
}

function TemperatureView({
  basis,
  anchor,
}: {
  readonly basis: TemperatureBasis;
  readonly anchor: AssetRecord;
}) {
  const [stepTo, setStepTo] = useState(230);
  const [seconds, setSeconds] = useState(30);
  const reading = laggedReadingC(basis, stepTo, seconds);
  const ma = loopCurrentMa(reading, basis.lrvC, basis.urvC);
  const band = anchor.telemetry?.normal;
  const alarmHigh = anchor.telemetry?.alarmHigh;
  const alarmLow = anchor.telemetry?.alarmLow;
  const horizon = basis.tauS * 6;
  const lagC = stepTo - reading;
  const inAlarm =
    (alarmHigh !== undefined && reading > alarmHigh) ||
    (alarmLow !== undefined && reading < alarmLow);
  return (
    <Frame
      title="Process view · sensor lag after a step"
      basis={`Pt100 to IEC 60751 in a flanged thermowell, first-order time constant τ ${basis.tauS} s; line at ${basis.initialC} °C before the step. Output 4–20 mA over ${basis.lrvC}–${basis.urvC} °C${band ? `; register normal band ${band[0]}–${band[1]} °C shaded` : ""}.`}
    >
      <Slider
        label="Line steps to"
        unit="°C"
        value={stepTo}
        min={basis.lrvC}
        max={basis.urvC}
        step={1}
        digits={0}
        onChange={setStepTo}
      />
      <Slider
        label="Time after step"
        unit="s"
        value={seconds}
        min={0}
        max={horizon}
        step={1}
        digits={0}
        onChange={setSeconds}
      />
      <CurveChart
        label={`Indicated temperature after the line steps from ${basis.initialC} to ${stepTo} °C: ${format(reading, 1)} °C at ${seconds} s; dashed line is the line temperature.`}
        curves={[
          { points: sample(0, horizon, 2, () => stepTo), reference: true },
          { points: sample(0, horizon, 80, (t) => laggedReadingC(basis, stepTo, t)) },
        ]}
        x={{
          domain: [0, horizon],
          ticks: [0, 1, 2, 3, 4, 5, 6].map((k) => k * basis.tauS),
          unit: "s",
        }}
        y={{ domain: [basis.lrvC, basis.urvC], ticks: [0, 100, 200, 300], unit: "°C" }}
        band={band}
        marker={[seconds, reading]}
      />
      <Stats
        stats={[
          {
            label: "Indicated",
            value: format(reading, 1),
            unit: "°C",
            off: inAlarm,
            note:
              Math.abs(lagC) >= 0.5
                ? `${format(Math.abs(lagC), 1)} °C behind the line`
                : undefined,
          },
          { label: "Pt100", value: format(pt100Ohms(reading), 2), unit: "Ω" },
          { label: "Output", value: format(ma, 2), unit: "mA" },
        ]}
      />
    </Frame>
  );
}

/** The process view a scene's asset class calls for. The exchanger is handled by its caller. */
export function ProcessView({
  spec,
  anchor,
  register,
  tagOf,
}: {
  readonly spec: Exclude<ProcessSpec, { readonly kind: "exchanger" }>;
  readonly anchor: AssetRecord;
  readonly register: PlantRegister;
  readonly tagOf: (nodeId: string) => string | undefined;
}) {
  switch (spec.kind) {
    case "vessel":
      return <VesselView basis={spec.basis} />;
    case "control-valve":
      return (
        <ControlValveView
          basis={spec.basis}
          anchor={anchor}
          register={register}
          tagOf={tagOf}
        />
      );
    case "isolation-valve":
      return <GateValveView basis={spec.basis} />;
    case "flowmeter":
      return <FlowmeterView basis={spec.basis} anchor={anchor} register={register} />;
    case "temperature-transmitter":
      return <TemperatureView basis={spec.basis} anchor={anchor} />;
    case "level-transmitter":
      return <RadarView basis={spec.basis} />;
  }
}
