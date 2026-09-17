"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { SimulatedBadge } from "@/components/canvas/AssetPanels";
import type { PlantRegister } from "@/lib/canvas/engineering";
import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import {
  exchangerState,
  mapScene,
  SCENARIOS,
  scenarioTrend,
  type ExchangerState,
  type FieldScene,
  type MappedComponent,
  type ScenarioId,
} from "@/lib/twin/scene";

import type { PartTint } from "./TwinModel";
import styles from "./DigitalTwin.module.css";

/**
 * The digital twin view: field photograph, 3D model and P&ID, joined by one mapping.
 *
 * Selecting a component in any of the three — a box on the photo, a part of the model, a
 * row of the table — selects it in all of them and shows where it sits on the drawing. The
 * scenario panel runs the exchanger model over a shift and lights up the components each
 * failure acts on, in the photo and the model at once.
 */

// three.js is only paid for when the twin is opened.
const TwinModel = dynamic(() => import("./TwinModel"), {
  ssr: false,
  loading: () => <div className={styles.modelFallback}>Loading 3D model…</div>,
});

interface Kpi {
  readonly key: keyof ExchangerState;
  readonly label: string;
  readonly unit: string;
  readonly digits: number;
  /** Outside this band the value is flagged. */
  readonly band: readonly [number, number];
}

const KPIS: readonly Kpi[] = [
  { key: "dutyKw", label: "Heat duty", unit: "kW", digits: 0, band: [9500, 11000] },
  { key: "shellOutletC", label: "Shell outlet", unit: "°C", digits: 1, band: [118, 132] },
  { key: "tubeOutletC", label: "CW return", unit: "°C", digits: 1, band: [60, 72] },
  { key: "uValue", label: "Overall U", unit: "W/m²·K", digits: 0, band: [650, 800] },
  { key: "shellDpBar", label: "Shell ΔP", unit: "bar", digits: 3, band: [0.3, 0.55] },
  {
    key: "conductivity",
    label: "CW conductivity",
    unit: "µS/cm",
    digits: 0,
    band: [250, 500],
  },
];

const SEVERITY_WORD: Record<PartTint, string> = {
  selected: "Selected",
  hover: "",
  warn: "Degrading",
  alarm: "Failure acting",
};

function severity(scenario: ScenarioId, hour: number): PartTint | undefined {
  const t = hour / 24;
  if (scenario === "fouling") return t > 0.55 ? "alarm" : t > 0.15 ? "warn" : undefined;
  if (scenario === "tube-leak") return t >= 0.6 ? "alarm" : undefined;
  if (scenario === "inlet-valve-closed") return t >= 0.5 ? "alarm" : undefined;
  return undefined;
}

const format = (value: number, digits: number) =>
  value.toLocaleString("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

function targetText(component: MappedComponent): string {
  const { target } = component;
  switch (target.kind) {
    case "asset":
    case "part":
      return `${target.tag} · ${target.name}`;
    case "line":
      return `Line ${target.number}`;
    case "unmapped":
      return "Not mapped";
  }
}

/** The source nodes that stand for a mapped component on the drawing. */
function nodesFor(component: MappedComponent, register: PlantRegister): readonly string[] {
  const { target } = component;
  if (target.kind === "asset" || target.kind === "part") return [target.nodeId];
  if (target.kind === "line") {
    const line = register.lines.get(target.lineId);
    return line ? [...line.members, ...line.assets] : [];
  }
  return [];
}

/** The drawing around a component, cut from the real sheet, with the component ringed. */
function DrawingCrop({
  nodes,
  imageUrl,
  drawing,
}: {
  readonly nodes: readonly DrawingNode[];
  readonly imageUrl: string;
  readonly drawing: CanvasDrawing;
}) {
  if (!nodes.length) {
    return <div className={styles.cropEmpty}>No symbol on the drawing</div>;
  }
  const x0 = Math.min(...nodes.map((n) => n.x - n.width / 2));
  const x1 = Math.max(...nodes.map((n) => n.x + n.width / 2));
  const y0 = Math.min(...nodes.map((n) => n.y - n.height / 2));
  const y1 = Math.max(...nodes.map((n) => n.y + n.height / 2));
  const span = Math.max(x1 - x0, y1 - y0, 90) * 1.5;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const stroke = span / 110;
  return (
    <svg
      className={styles.crop}
      viewBox={`${cx - span / 2} ${cy - span / 2} ${span} ${span}`}
      role="img"
      aria-label="The component as drawn on the P&ID"
    >
      <rect x={0} y={0} width={drawing.width} height={drawing.height} fill="#ffffff" />
      <image href={imageUrl} x={0} y={0} width={drawing.width} height={drawing.height} />
      {nodes.map((node) => (
        <rect
          key={node.id}
          x={node.x - node.width / 2 - stroke * 2}
          y={node.y - node.height / 2 - stroke * 2}
          width={node.width + stroke * 4}
          height={node.height + stroke * 4}
          rx={stroke * 2}
          fill="rgba(29, 78, 216, 0.1)"
          stroke="#1d4ed8"
          strokeWidth={stroke}
        />
      ))}
    </svg>
  );
}

function TrendChart({
  scenario,
  kpi,
  hour,
}: {
  readonly scenario: ScenarioId;
  readonly kpi: Kpi;
  readonly hour: number;
}) {
  const series = useMemo(() => scenarioTrend(scenario), [scenario]);
  const baseline = useMemo(() => scenarioTrend("normal"), []);
  const values = [...series, ...baseline].map((p) => p.state[kpi.key]);
  const lo = Math.min(...values, kpi.band[0]);
  const hi = Math.max(...values, kpi.band[1]);
  const pad = (hi - lo) * 0.08 || 1;
  const W = 520;
  const H = 150;
  const x = (h: number) => 34 + (h / 24) * (W - 44);
  const y = (v: number) => 10 + (1 - (v - (lo - pad)) / (hi - lo + pad * 2)) * (H - 30);
  const path = (points: typeof series) =>
    points
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${x(p.hour).toFixed(1)},${y(p.state[kpi.key]).toFixed(1)}`,
      )
      .join("");

  return (
    <svg
      className={styles.trend}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${kpi.label} over 24 hours`}
    >
      <rect
        x={34}
        y={y(kpi.band[1])}
        width={W - 44}
        height={Math.max(0, y(kpi.band[0]) - y(kpi.band[1]))}
        fill="#e8f6ef"
      />
      {[0, 6, 12, 18, 24].map((h) => (
        <g key={h}>
          <line x1={x(h)} x2={x(h)} y1={10} y2={H - 20} stroke="#ebeef4" />
          <text x={x(h)} y={H - 6} textAnchor="middle">
            {String(h).padStart(2, "0")}:00
          </text>
        </g>
      ))}
      <text x={30} y={y(kpi.band[1]) + 4} textAnchor="end">
        {format(kpi.band[1], kpi.digits > 1 ? 2 : kpi.digits)}
      </text>
      <text x={30} y={y(kpi.band[0]) + 4} textAnchor="end">
        {format(kpi.band[0], kpi.digits > 1 ? 2 : kpi.digits)}
      </text>
      {scenario !== "normal" && (
        <path
          d={path(baseline)}
          fill="none"
          stroke="#9aa6b6"
          strokeDasharray="4 4"
          strokeWidth={1.4}
        />
      )}
      <path d={path(series)} fill="none" stroke="#1d4ed8" strokeWidth={2} />
      <line
        x1={x(hour)}
        x2={x(hour)}
        y1={10}
        y2={H - 20}
        stroke="#141d2b"
        strokeWidth={1.2}
      />
    </svg>
  );
}

export function DigitalTwinView({
  scene,
  anchorId,
  anchorConfirmed,
  drawing,
  register,
  adjacency,
  imageUrl,
  sheet,
  hierarchy,
  tagOf,
  onShowOnDrawing,
  onAsk,
}: {
  readonly scene: FieldScene;
  readonly anchorId: string | undefined;
  /** True when the anchor is a symbol the scene names, not the best guess on this sheet. */
  readonly anchorConfirmed: boolean;
  readonly drawing: CanvasDrawing;
  readonly register: PlantRegister;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly imageUrl: string;
  readonly sheet: string;
  readonly hierarchy: string;
  /** The tag to show for a source node: printed if the agent read one, else the register's. */
  readonly tagOf: (nodeId: string) => string | undefined;
  readonly onShowOnDrawing: (nodeId: string) => void;
  readonly onAsk: (question: string) => void;
}) {
  const mapped = useMemo(
    () => (anchorId ? mapScene(scene, anchorId, drawing, register, adjacency) : []),
    [scene, anchorId, drawing, register, adjacency],
  );
  const byId = useMemo(() => new Map(mapped.map((m) => [m.detection.id, m])), [mapped]);
  const nodeById = useMemo(() => new Map(drawing.nodes.map((n) => [n.id, n])), [drawing]);

  const [selected, setSelected] = useState<string>(scene.detections[0]!.id);
  const [boxHover, setBoxHover] = useState<string>();
  const [labels, setLabels] = useState(true);
  const [scenario, setScenario] = useState<ScenarioId>("normal");
  const [hour, setHour] = useState(24);
  const [playing, setPlaying] = useState(false);
  const [kpiKey, setKpiKey] = useState<keyof ExchangerState>("shellOutletC");

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setHour((value) => {
        if (value >= 24) {
          setPlaying(false);
          return 24;
        }
        return Math.min(24, value + 0.5);
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [playing]);

  const scenarioInfo = SCENARIOS.find((s) => s.id === scenario)!;
  const level = severity(scenario, hour);
  // Stable between ticks of the same severity, so the 3D model repaints only on a change.
  const tints = useMemo(
    () =>
      new Map<string, PartTint>(
        level ? scenarioInfo.affects.map((id) => [id, level] as const) : [],
      ),
    [scenarioInfo, level],
  );

  const anchor = anchorId ? register.assets.get(anchorId) : undefined;
  if (!anchorId || !anchor) {
    return (
      <div className={styles.twin}>
        <div className={styles.empty}>
          <strong>No vessel on this sheet to anchor the twin on</strong>
          <p>
            The field scene depicts a shell-and-tube exchanger. Open a sheet that carries a
            vessel symbol — the OPEN100 main steam sheet anchors it on its steam generator.
          </p>
        </div>
      </div>
    );
  }

  const anchorTag = tagOf(anchorId) ?? anchor.tag;
  const component = byId.get(selected);
  const state = exchangerState(scenario, hour / 24);
  const normal = exchangerState("normal", hour / 24);
  const kpi = KPIS.find((k) => k.key === kpiKey)!;
  const mappedCount = mapped.filter((m) => m.target.kind !== "unmapped").length;

  const nameOf = (id: string) => {
    const m = byId.get(id);
    if (!m) return id;
    const node = nodeOf(m);
    const tag = node ? tagOf(node) : undefined;
    return `${m.detection.id} ${m.detection.label} → ${tag ?? targetText(m)}`;
  };
  const nodeOf = (m: MappedComponent) =>
    m.target.kind === "asset" || m.target.kind === "part" ? m.target.nodeId : undefined;
  const displayTarget = (m: MappedComponent) => {
    const node = nodeOf(m);
    const printed = node ? tagOf(node) : undefined;
    return printed && m.target.kind !== "line" && m.target.kind !== "unmapped"
      ? `${printed} · ${m.target.name}`
      : targetText(m);
  };

  const cropNodes = component
    ? nodesFor(component, register)
        .map((id) => nodeById.get(id))
        .filter((n): n is DrawingNode => Boolean(n))
    : [];
  const drawingNode = component
    ? (nodeOf(component) ??
      (component.target.kind === "line"
        ? (register.lines.get(component.target.lineId)?.assets[0] ??
          register.lines.get(component.target.lineId)?.members[0])
        : undefined))
    : undefined;

  const findings = KPIS.flatMap((k) => {
    const value = state[k.key];
    if (value >= k.band[0] && value <= k.band[1]) return [];
    return [
      `${k.label} ${format(value, k.digits)} ${k.unit} is ${value > k.band[1] ? "above" : "below"} its normal band of ${format(k.band[0], k.digits)}–${format(k.band[1], k.digits)}`,
    ];
  });

  const boxKey = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(id);
    }
  };

  return (
    <div className={styles.twin}>
      <header className={styles.head}>
        <div>
          <h2>
            Digital twin · {anchorTag} {anchor.name}
          </h2>
          <p>
            {hierarchy} · {mappedCount} of {mapped.length} field components mapped to{" "}
            {sheet}
          </p>
        </div>
        <div className={styles.headBadges}>
          <SimulatedBadge label="Generated field image" />
          <SimulatedBadge label="Simulated process" />
        </div>
      </header>
      {!anchorConfirmed && (
        <p className={styles.caution}>
          This sheet does not identify an exchanger. The twin is anchored on {anchor.tag},
          the vessel joined to the most equipment, as a working hypothesis.
        </p>
      )}

      <div className={styles.views}>
        <section className={styles.card} aria-label="Field image with detections">
          <header>
            <h3>Field image · {scene.detections.length} detections</h3>
            <button aria-pressed={labels} onClick={() => setLabels((v) => !v)}>
              Labels
            </button>
          </header>
          <svg
            className={styles.photo}
            viewBox={`0 0 ${scene.imageWidth} ${scene.imageHeight}`}
            role="group"
            aria-label="Field photograph. Each detected component is a selectable box."
          >
            <image href={scene.image} width={scene.imageWidth} height={scene.imageHeight} />
            {scene.detections.map((d) => {
              const [x0, y0, x1, y1] = d.box;
              const tint = d.id === selected ? "selected" : tints.get(d.id);
              const m = byId.get(d.id);
              const node = m ? nodeOf(m) : undefined;
              const chip = `${d.id} · ${node ? (tagOf(node) ?? "") : m?.target.kind === "line" ? m.target.number : d.label}`;
              const show = labels || d.id === selected || d.id === boxHover;
              return (
                <g
                  key={d.id}
                  className={styles.box}
                  data-tint={tint ?? "none"}
                  data-hover={d.id === boxHover || undefined}
                  role="button"
                  tabIndex={0}
                  aria-pressed={d.id === selected}
                  aria-label={nameOf(d.id)}
                  onClick={() => setSelected(d.id)}
                  onKeyDown={(event) => boxKey(event, d.id)}
                  onPointerEnter={() => setBoxHover(d.id)}
                  onPointerLeave={() => setBoxHover(undefined)}
                >
                  <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={6} />
                  {show && (
                    <g transform={`translate(${x0}, ${Math.max(0, y0 - 30)})`}>
                      <rect
                        className={styles.chipBg}
                        width={chip.length * 12.5 + 18}
                        height={28}
                        rx={5}
                      />
                      <text x={9} y={19.5}>
                        {chip}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </section>

        <section className={styles.card} aria-label="3D model">
          <header>
            <h3>3D model</h3>
            <span className={styles.muted}>Procedural · parts share detection ids</span>
          </header>
          <TwinModel
            selected={selected}
            tints={tints}
            onSelect={setSelected}
            labelOf={nameOf}
          />
        </section>
      </div>

      <div className={styles.details}>
        <section className={styles.card} aria-label="Selected component">
          <header>
            <h3>Selected component</h3>
            {component && <span className={styles.idChip}>{component.detection.id}</span>}
          </header>
          {component && (
            <div className={styles.selection}>
              <DrawingCrop nodes={cropNodes} imageUrl={imageUrl} drawing={drawing} />
              <div>
                <strong>{component.detection.label}</strong>
                <p className={styles.muted}>{component.detection.description}</p>
                <dl className={styles.facts}>
                  <div>
                    <dt>P&ID target</dt>
                    <dd>{displayTarget(component)}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>
                      <span className={styles.confidence} data-level={component.confidence}>
                        {component.confidence}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Mapping basis</dt>
                    <dd>
                      {component.target.kind === "unmapped"
                        ? component.target.reason
                        : component.basis}
                    </dd>
                  </div>
                  {level && scenarioInfo.affects.includes(component.detection.id) && (
                    <div>
                      <dt>Scenario</dt>
                      <dd className={styles.alarmText}>
                        {SEVERITY_WORD[level]} · {scenarioInfo.failureCode}{" "}
                        {scenarioInfo.name}
                      </dd>
                    </div>
                  )}
                </dl>
                <div className={styles.actions}>
                  <button
                    disabled={!drawingNode}
                    onClick={() => drawingNode && onShowOnDrawing(drawingNode)}
                  >
                    Show on drawing
                  </button>
                  <button
                    className={styles.primaryAction}
                    onClick={() =>
                      onAsk(
                        `On ${sheet}, the field photo component "${component.detection.label}" maps to ${displayTarget(component)} of ${anchorTag}. Explain what it does, everything it is connected to, how it is most likely to fail and what each failure would do to ${anchorTag}'s duty and outlet temperature.`,
                      )
                    }
                  >
                    Ask agent
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className={styles.card} aria-label="Process simulation">
          <header>
            <h3>Process simulation · ε-NTU</h3>
            <SimulatedBadge />
          </header>
          <div className={styles.scenarios} role="group" aria-label="Scenario">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                aria-pressed={scenario === s.id}
                onClick={() => {
                  setScenario(s.id);
                  if (s.affects[0]) setSelected(s.affects[0]);
                }}
              >
                {s.failureCode ? <b>{s.failureCode}</b> : null}
                {s.name}
              </button>
            ))}
          </div>
          <p className={styles.muted}>{scenarioInfo.summary}</p>
          <div className={styles.clock}>
            <button
              onClick={() => {
                if (hour >= 24) setHour(0);
                setPlaying((v) => !v);
              }}
            >
              {playing ? "Pause" : "Play shift"}
            </button>
            <label>
              <span className="srOnly">Hour of shift</span>
              <input
                type="range"
                min={0}
                max={24}
                step={0.5}
                value={hour}
                onChange={(event) => {
                  setPlaying(false);
                  setHour(Number(event.target.value));
                }}
              />
            </label>
            <output>
              {String(Math.floor(hour)).padStart(2, "0")}:{hour % 1 ? "30" : "00"}
            </output>
          </div>
          <div className={styles.kpis}>
            {KPIS.map((k) => {
              const value = state[k.key];
              const off = value < k.band[0] || value > k.band[1];
              const delta = value - normal[k.key];
              return (
                <button
                  key={k.key}
                  className={styles.kpi}
                  data-off={off || undefined}
                  aria-pressed={kpiKey === k.key}
                  onClick={() => setKpiKey(k.key)}
                  title="Plot this variable"
                >
                  <small>{k.label}</small>
                  <strong>
                    {format(value, k.digits)} <span>{k.unit}</span>
                  </strong>
                  <em>
                    {scenario === "normal" || Math.abs(delta) < 10 ** -k.digits
                      ? off
                        ? "Out of band"
                        : "In band"
                      : `${delta > 0 ? "+" : "−"}${format(Math.abs(delta), k.digits)} vs clean`}
                  </em>
                </button>
              );
            })}
          </div>
        </section>

        <section className={styles.card} aria-label="Trend and diagnosis">
          <header>
            <h3>{kpi.label} · 24 h</h3>
            <span className={styles.muted}>Band shaded · dashed = clean</span>
          </header>
          <TrendChart scenario={scenario} kpi={kpi} hour={hour} />
          <h4>
            Diagnosis at {String(Math.floor(hour)).padStart(2, "0")}:
            {hour % 1 ? "30" : "00"}
          </h4>
          {findings.length ? (
            <ul className={styles.findings}>
              {findings.map((f) => (
                <li key={f}>{f}.</li>
              ))}
              {level && (
                <li>
                  Consistent with ISO 14224 {scenarioInfo.failureCode} (
                  {scenarioInfo.name.toLowerCase()}); acting on{" "}
                  {scenarioInfo.affects
                    .map((id) => byId.get(id)?.detection.label ?? id)
                    .join(", ")}
                  .
                </li>
              )}
            </ul>
          ) : (
            <p className={styles.muted}>All six variables inside their normal bands.</p>
          )}
          {scenario !== "normal" && (
            <button
              className={styles.askScenario}
              onClick={() =>
                onAsk(
                  `${anchorTag} (${anchor.name}) on ${sheet} is showing ${scenarioInfo.name.toLowerCase()}: ${findings.join("; ") || "no deviation yet"}. Using the drawing, list the connected valves, instruments and lines that would detect or be affected by this, and recommend the isolation and inspection steps in order.`,
                )
              }
            >
              Ask agent about this scenario
            </button>
          )}
        </section>
      </div>

      <section className={styles.card} aria-label="Mapping register">
        <header>
          <h3>Field → P&ID mapping register</h3>
          <span className={styles.muted}>
            Anchor {anchorTag} · source node {anchorId}
          </span>
        </header>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Field component</th>
                <th scope="col">Class</th>
                <th scope="col">P&ID target</th>
                <th scope="col">Confidence</th>
                <th scope="col">Basis</th>
                <th scope="col">Scenario</th>
              </tr>
            </thead>
            <tbody>
              {mapped.map((m) => {
                const tint = tints.get(m.detection.id);
                return (
                  <tr key={m.detection.id} aria-selected={m.detection.id === selected}>
                    <td>
                      <button
                        onClick={() => setSelected(m.detection.id)}
                        aria-label={`Select ${m.detection.label}`}
                      >
                        {m.detection.id}
                      </button>
                    </td>
                    <td>{m.detection.label}</td>
                    <td>{m.detection.cls.replace("-", " ")}</td>
                    <td
                      className={
                        m.target.kind === "unmapped" ? styles.alarmText : undefined
                      }
                    >
                      {displayTarget(m)}
                    </td>
                    <td>
                      <span className={styles.confidence} data-level={m.confidence}>
                        {m.confidence}
                      </span>
                    </td>
                    <td className={styles.muted}>
                      {m.target.kind === "unmapped" ? m.target.reason : m.basis}
                    </td>
                    <td>
                      {tint ? (
                        <span className={styles.tint} data-tint={tint}>
                          {SEVERITY_WORD[tint]}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
