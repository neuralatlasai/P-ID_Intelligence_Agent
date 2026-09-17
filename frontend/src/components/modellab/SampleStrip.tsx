"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import type { PlantRegister } from "@/lib/canvas/engineering";
import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import {
  verifierFindings,
  type InjectedError,
  type SampleProvenance,
} from "@/lib/modellab/policy";
import type { GroundedAnswer, LabSample, Verification } from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";

import { Icon, type IconName } from "./icons";
import styles from "./ModelLab.module.css";
import local from "./SampleStrip.module.css";

/** A policy's answer for one rollout, the errors injected into it, and the verifier's verdict. */
export interface PolicyResult {
  readonly answer: GroundedAnswer;
  readonly injected: readonly InjectedError[];
  readonly verification: Verification;
}

// three.js loads only when a stage that shows the 3D panel is opened.
const DeviceModel = dynamic(() => import("./DeviceModel"), {
  ssr: false,
  loading: () => <div className={styles.modelFallback}>Loading 3D model…</div>,
});

const canvasHref = (nodeId: string, view?: string) =>
  `/canvas?node=${encodeURIComponent(nodeId)}${view ? `&view=${view}` : ""}`;

export function SampleStrip({
  stage,
  sample,
  samples,
  index,
  onChoose,
  autoCycle,
  onToggleCycle,
  drawing,
  imageUrl,
  register,
  answer,
  student,
  verification,
  studentVerification,
  now,
  running,
  policy,
  teacherPolicy,
  studentPolicy,
  rolloutLabel,
  provenance,
  cycleSecondsLeft,
  cyclePeriodSeconds = 15,
}: {
  readonly stage: Stage;
  readonly sample: LabSample;
  readonly samples: readonly LabSample[];
  readonly index: number;
  readonly onChoose: (index: number) => void;
  readonly autoCycle: boolean;
  readonly onToggleCycle: () => void;
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
  readonly register: PlantRegister;
  readonly answer: GroundedAnswer | undefined;
  readonly student: GroundedAnswer | undefined;
  readonly verification: Verification | undefined;
  readonly studentVerification: Verification | undefined;
  readonly now: number;
  readonly running: boolean;
  /** Stage 3: the policy rollout shown in place of the perfectly composed answer. */
  readonly policy?: PolicyResult;
  /** Stage 4: the teacher's and student's rollouts, verified on their own merits. */
  readonly teacherPolicy?: PolicyResult;
  readonly studentPolicy?: PolicyResult;
  /** E.g. "rollout 482,113". */
  readonly rolloutLabel?: string;
  readonly provenance?: SampleProvenance;
  /** Seconds until auto-cycle moves to the next sample; shown only while auto-cycling. */
  readonly cycleSecondsLeft?: number;
  readonly cyclePeriodSeconds?: number;
}) {
  const rlVerification = policy?.verification ?? verification;
  const teacherAnswer = teacherPolicy?.answer ?? answer;
  const studentAnswer = studentPolicy?.answer ?? student;
  const teacherCheck = teacherPolicy?.verification ?? verification;
  const studentCheck = studentPolicy?.verification ?? studentVerification;
  const label = stage.id === "sft" ? sample.annotationId : sample.tag;
  const choose = (nodeId: string) => {
    const found = samples.findIndex((item) => item.nodeId === nodeId);
    if (found >= 0) onChoose(found);
  };

  const panels: ReactNode[] = [
    <Panel
      key="image"
      title={stage.id === "sft" ? "Field image (asset photo)" : "Field image (RGB)"}
    >
      <FieldImage
        sample={sample}
        label={label}
        variant={stage.id === "sft" ? "red" : "blue"}
        zoomable={stage.id === "rl"}
      />
    </Panel>,
    <Panel key="pid" title={stage.id === "sft" ? "P&ID source (linked)" : "P&ID crop"}>
      <PidCrop
        node={sample.node}
        drawing={drawing}
        imageUrl={imageUrl}
        label={label}
        line={sample.line?.number}
        nodeId={sample.nodeId}
      />
    </Panel>,
  ];

  if (stage.id === "pretraining") {
    panels.push(
      <Panel key="3d" title="3D twin / CAD geometry" note="Procedural">
        <DeviceModel fieldClass={sample.fieldClass} label={label} />
      </Panel>,
      <Panel key="graph" title="Local topology graph" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="equipment" />
      </Panel>,
    );
  } else if (stage.id === "sft") {
    panels.push(
      <Panel key="evidence" title="Evidence map (multi-modal)">
        <EvidenceMap sample={sample} label={label} />
      </Panel>,
      <Panel key="trace" title="Reasoning trace (excerpt)" wide>
        {answer && <ReasoningTrace answer={answer} sample={sample} />}
      </Panel>,
    );
  } else if (stage.id === "rl") {
    panels.push(
      <Panel key="graph" title="Topology graph" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="none" />
      </Panel>,
      <Panel key="verifier" title="Verifier result (simulator response)">
        {rlVerification && <VerifierResult verification={rlVerification} />}
        {policy && (
          <RolloutFindings
            policy={policy}
            rolloutLabel={rolloutLabel ?? provenance?.rolloutId}
          />
        )}
      </Panel>,
      <Panel key="actions" title="Action trace" narrow>
        <ActionTrace
          sample={sample}
          verification={rlVerification}
          now={now}
          running={running}
          revise={policy !== undefined}
        />
      </Panel>,
    );
  } else {
    panels.push(
      <Panel key="graph" title="Topology graph" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="process" />
      </Panel>,
      <Panel key="compare" title="Teacher → Student response comparison" wide>
        {teacherAnswer && studentAnswer && teacherCheck && studentCheck && (
          <TeacherStudent
            teacher={teacherAnswer}
            student={studentAnswer}
            teacherCheck={teacherCheck}
            studentCheck={studentCheck}
            teacherInjected={teacherPolicy?.injected}
            studentInjected={studentPolicy?.injected}
            register={register}
          />
        )}
      </Panel>,
    );
  }

  return (
    <section
      className={`${styles.card} ${styles.sampleCard}`}
      aria-label={stage.sampleTitle}
    >
      <header className={styles.cardHeader}>
        <span className={styles.cardIcon}>
          <Icon name="sample" size={19} />
        </span>
        <h2>{stage.sampleTitle}</h2>
        <span className={styles.cardAside}>
          <span className={local.cycleGroup}>
            <button
              className={`${styles.cycle} ${local.cycleButton}`}
              aria-pressed={autoCycle}
              onClick={onToggleCycle}
              title={`Cycle samples every ${cyclePeriodSeconds} s while the stage runs`}
            >
              {autoCycle ? "Auto" : "Manual"}
            </button>
            {autoCycle && cycleSecondsLeft !== undefined && (
              <Countdown seconds={cycleSecondsLeft} period={cyclePeriodSeconds} />
            )}
          </span>
          <span className={styles.equipment}>
            Equipment: <strong>{sample.tag}</strong>
          </span>
          <span className={styles.pager}>
            <button aria-label="Previous sample" onClick={() => onChoose(index - 1)}>
              <Icon name="prev" size={15} />
            </button>
            <span aria-live="polite">
              {index + 1} of {samples.length}
            </span>
            <button aria-label="Next sample" onClick={() => onChoose(index + 1)}>
              <Icon name="next" size={15} />
            </button>
          </span>
        </span>
      </header>
      {provenance && <ProvenanceLine provenance={provenance} />}
      <div className={styles.panels} data-stage={stage.id}>
        {panels}
        <span className={styles.alignLine} aria-hidden="true" />
      </div>
    </section>
  );
}

function Panel({
  title,
  note,
  wide,
  narrow,
  children,
}: {
  readonly title: string;
  readonly note?: string;
  readonly wide?: boolean;
  readonly narrow?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={styles.panel}
      data-wide={wide || undefined}
      data-narrow={narrow || undefined}
    >
      <h3>
        {title}
        {note ? <small>{note}</small> : null}
      </h3>
      <div className={styles.panelBody}>{children}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Field image and P&ID crop
// ────────────────────────────────────────────────────────────────────────────────────────────

function FieldImage({
  sample,
  label,
  variant,
  zoomable,
}: {
  readonly sample: LabSample;
  readonly label: string;
  readonly variant: "blue" | "red";
  readonly zoomable: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const { box } = sample;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return (
    <figure className={styles.fieldImage}>
      <div
        className={styles.fieldInner}
        style={{ transform: `scale(${zoom})`, transformOrigin: `${cx}% ${cy}%` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={sample.image}
          alt={`Generated field reference: ${sample.fieldClass.toLowerCase()} registered to ${sample.tag}`}
          loading="lazy"
        />
        <span
          className={styles.detection}
          data-variant={variant}
          style={{
            left: `${box.x}%`,
            top: `${box.y}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
          }}
        >
          <b>{label}</b>
        </span>
      </div>
      <figcaption>Generated reference · {sample.fieldClass}</figcaption>
      {zoomable && (
        <span className={styles.zoom}>
          <button
            aria-label="Zoom in on the detection"
            onClick={() => setZoom((z) => Math.min(2.4, z + 0.4))}
          >
            <Icon name="zoomIn" size={14} />
          </button>
          <button
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(1, z - 0.4))}
          >
            <Icon name="zoomOut" size={14} />
          </button>
        </span>
      )}
    </figure>
  );
}

function PidCrop({
  node,
  drawing,
  imageUrl,
  label,
  line,
  nodeId,
}: {
  readonly node: DrawingNode;
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
  readonly label: string;
  readonly line: string | undefined;
  readonly nodeId: string;
}) {
  const span = Math.max(node.width, node.height, 40) * 4.2;
  const width = span * 1.35;
  const height = span;
  const pad = Math.max(node.width, node.height) * 0.35;
  return (
    <Link
      href={canvasHref(nodeId)}
      className={styles.pidCrop}
      title="Open this symbol on the canvas"
    >
      <svg
        viewBox={`${node.x - width / 2} ${node.y - height / 2} ${width} ${height}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`${label} as drawn on the P&ID${line ? `, line ${line}` : ""}`}
      >
        <rect
          x={node.x - width / 2}
          y={node.y - height / 2}
          width={width}
          height={height}
          fill="#ffffff"
        />
        <image href={imageUrl} width={drawing.width} height={drawing.height} />
        <rect
          x={node.x - node.width / 2 - pad}
          y={node.y - node.height / 2 - pad}
          width={node.width + pad * 2}
          height={node.height + pad * 2}
          fill="rgba(220, 38, 38, 0.06)"
          stroke="#dc2626"
          strokeWidth={span / 110}
          strokeDasharray={`${span / 40} ${span / 60}`}
        />
      </svg>
      <b className={styles.pidChip} style={{ left: "50%", top: "10%" }}>
        {label}
      </b>
      {line && <span className={styles.lineLabel}>{line}</span>}
    </Link>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Topology
// ────────────────────────────────────────────────────────────────────────────────────────────

const GROUP_COLOUR = {
  equipment: "#93c5fd",
  instrument: "#60a5fa",
  process: "#4ade80",
} as const;

function shortFunction(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("pressure")) return "pressure";
  if (lower.includes("temperature")) return "temperature";
  if (lower.includes("flow")) return "flow";
  if (lower.includes("level")) return "level";
  if (lower.includes("analysis")) return "analysis";
  if (lower.includes("vibration")) return "vibration";
  if (lower.includes("manual") || lower.includes("gate")) return "isolation";
  if (lower.includes("exchanger")) return "exchanger";
  if (lower.includes("drum") || lower.includes("separator") || lower.includes("vessel"))
    return "vessel";
  if (lower.includes("pump")) return "pump";
  if (lower.includes("off-page")) return "off-page";
  return lower.split(" ")[0] ?? "";
}

function Topology({
  sample,
  onChoose,
  legend,
}: {
  readonly sample: LabSample;
  readonly onChoose: (nodeId: string) => void;
  readonly legend: "equipment" | "process" | "none";
}) {
  const neighbours = sample.neighbours;
  const positions = neighbours.map((_, i) => {
    const count = neighbours.length;
    const angle =
      count === 1
        ? Math.PI / 2
        : Math.PI * 0.95 + (i / Math.max(1, count - 1)) * Math.PI * 1.1;
    return { x: 50 + 36 * Math.cos(angle), y: 44 + 30 * Math.sin(angle) };
  });
  return (
    <div className={styles.topology}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {positions.map((p, i) => (
          <line
            key={neighbours[i]!.id}
            x1={50}
            y1={44}
            x2={p.x}
            y2={p.y}
            className={styles.edge}
          />
        ))}
      </svg>
      <span className={styles.hub} style={{ left: "50%", top: "44%" }}>
        {sample.tag}
      </span>
      {neighbours.map((n, i) => {
        const pos = positions[i]!;
        const content = (
          <>
            <i style={{ background: GROUP_COLOUR[n.group] }} aria-hidden="true" />
            <span>
              {n.tag}
              <small>({shortFunction(n.name)})</small>
            </span>
          </>
        );
        return n.sampled ? (
          <button
            key={n.id}
            className={styles.satellite}
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            onClick={() => onChoose(n.id)}
            title={`${n.tag} ${n.name} · ${n.hops} hops · open this sample`}
          >
            {content}
          </button>
        ) : (
          <Link
            key={n.id}
            className={styles.satellite}
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            href={canvasHref(n.id)}
            title={`${n.tag} ${n.name} · ${n.hops} hops · open on the canvas`}
          >
            {content}
          </Link>
        );
      })}
      {legend !== "none" && (
        <ul className={styles.topologyLegend}>
          {(legend === "equipment"
            ? ([
                ["Equipment", GROUP_COLOUR.equipment],
                ["Instrument", GROUP_COLOUR.instrument],
                ["Process unit", GROUP_COLOUR.process],
              ] as const)
            : ([
                ["Process", GROUP_COLOUR.process],
                ["Instrument", GROUP_COLOUR.instrument],
                ["Control", GROUP_COLOUR.equipment],
              ] as const)
          ).map(([name, colour]) => (
            <li key={name}>
              <i style={{ background: colour }} aria-hidden="true" />
              {name}
            </li>
          ))}
          {legend === "process" && <li className={styles.dashedKey}>P&ID link</li>}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stage 2: evidence map and reasoning trace
// ────────────────────────────────────────────────────────────────────────────────────────────

function EvidenceMap({
  sample,
  label,
}: {
  readonly sample: LabSample;
  readonly label: string;
}) {
  const items: {
    name: string;
    count: number;
    icon: IconName;
    href: string;
    colour: string;
    x: number;
    y: number;
  }[] = [
    {
      name: "Field Image",
      count: sample.evidence.fieldImages,
      icon: "canvas",
      href: canvasHref(sample.nodeId),
      colour: "#22c55e",
      x: 30,
      y: 14,
    },
    {
      name: "P&ID",
      count: sample.evidence.pid,
      icon: "reports",
      href: canvasHref(sample.nodeId),
      colour: "#2563eb",
      x: 70,
      y: 14,
    },
    {
      name: "3D Twin",
      count: sample.evidence.twin,
      icon: "cube",
      href: canvasHref(sample.nodeId, "Twin"),
      colour: "#16a34a",
      x: 80,
      y: 46,
    },
    {
      name: "Manuals",
      count: sample.evidence.manuals,
      icon: "book",
      href: canvasHref(sample.nodeId, "Files"),
      colour: "#f59e0b",
      x: 70,
      y: 78,
    },
    {
      name: "Time-series",
      count: sample.evidence.timeSeries,
      icon: "monitoring",
      href: canvasHref(sample.nodeId),
      colour: "#06b6d4",
      x: 30,
      y: 78,
    },
    {
      name: "Graph Topology",
      count: sample.evidence.graph,
      icon: "graph",
      href: canvasHref(sample.nodeId, "Assets"),
      colour: "#7c3aed",
      x: 21,
      y: 46,
    },
  ];
  return (
    <div className={styles.evidence}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {items.map((item) => (
          <line
            key={item.name}
            x1={50}
            y1={50}
            x2={item.x}
            y2={item.y}
            className={styles.edge}
          />
        ))}
      </svg>
      <span className={styles.hub} style={{ left: "50%", top: "50%" }}>
        {label}
      </span>
      {items.map((item) => (
        <Link
          key={item.name}
          href={item.href}
          className={styles.evidenceNode}
          style={{ left: `${item.x}%`, top: `${item.y}%`, color: item.colour }}
          title={`Open ${item.name.toLowerCase()} evidence for ${sample.tag}`}
        >
          <span>
            <Icon name={item.icon} size={14} />
          </span>
          <small>
            {item.name} ({item.count})
          </small>
        </Link>
      ))}
    </div>
  );
}

/** Reveal text progressively, as a streamed answer arrives; instant under reduced motion. */
function useReveal(text: string): string {
  const [shown, setShown] = useState(text.length);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let count = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restart the reveal for new text
    setShown(0);
    const timer = window.setInterval(() => {
      count += 4;
      setShown(Math.min(text.length, count));
      if (count >= text.length) window.clearInterval(timer);
    }, 16);
    return () => window.clearInterval(timer);
  }, [text]);
  return text.slice(0, shown);
}

function ReasoningTrace({
  answer,
  sample,
}: {
  readonly answer: GroundedAnswer;
  readonly sample: LabSample;
}) {
  const shown = useReveal(answer.text);
  const hrefFor: Record<GroundedAnswer["cites"][number], string> = {
    "P&ID": canvasHref(sample.nodeId),
    Trend: canvasHref(sample.nodeId),
    Procedure: canvasHref(sample.nodeId, "Files"),
    Topology: canvasHref(sample.nodeId, "Assets"),
  };
  const icons: Record<GroundedAnswer["cites"][number], IconName> = {
    "P&ID": "reports",
    Trend: "monitoring",
    Procedure: "file",
    Topology: "graph",
  };
  return (
    <div className={styles.trace} tabIndex={0} aria-label="Reasoning trace">
      <div className={styles.bubble} data-role="user">
        <span className={styles.bubbleIcon}>
          <Icon name="user" size={14} />
        </span>
        <div>
          <strong>User</strong>
          <p>{answer.question}</p>
        </div>
      </div>
      <div className={styles.bubble} data-role="model">
        <span className={styles.bubbleIcon}>
          <Icon name="robot" size={14} />
        </span>
        <div>
          <strong>Model (grounded reasoning)</strong>
          <p aria-live="polite">{shown}</p>
          <span className={styles.chips}>
            {answer.cites.map((cite) => (
              <Link key={cite} href={hrefFor[cite]} className={styles.citeChip}>
                <Icon name={icons[cite]} size={12} />
                {cite}
              </Link>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stage 3: verifier result and action trace
// ────────────────────────────────────────────────────────────────────────────────────────────

function VerifierResult({ verification }: { readonly verification: Verification }) {
  return (
    <table className={styles.verifier}>
      <tbody>
        {verification.checks.map((check) => (
          <tr key={check.id} title={check.detail}>
            <th scope="row">{check.label}</th>
            <td>
              <span className={styles.passMark} data-pass={check.pass || undefined}>
                <Icon name={check.pass ? "check" : "cross"} size={11} />
              </span>
              {check.pass ? "Pass" : "Fail"}
            </td>
            <td>{check.score.toFixed(2)}</td>
          </tr>
        ))}
        <tr className={`${styles.overall} ${verification.pass ? "" : local.overallFail}`}>
          <th scope="row">Overall verifier result</th>
          <td>
            <span className={styles.passMark} data-pass={verification.pass || undefined}>
              <Icon name={verification.pass ? "check" : "cross"} size={11} />
            </span>
            {verification.pass ? "Pass" : "Fail"}
          </td>
          <td>{verification.overall.toFixed(2)}</td>
        </tr>
      </tbody>
      {verification.fabricated.length > 0 && (
        <caption className={styles.fabricated}>
          Fabricated: {verification.fabricated.join(", ")}
        </caption>
      )}
    </table>
  );
}

function ActionTrace({
  sample,
  verification,
  now,
  running,
  revise = false,
}: {
  readonly sample: LabSample;
  readonly verification: Verification | undefined;
  readonly now: number;
  readonly running: boolean;
  /** Policy rollouts that fail verification are sent back for revision rather than shown. */
  readonly revise?: boolean;
}) {
  const steps: [string, string][] = [
    ["Observe", `Analyze image and P&ID (${sample.nodeId})`],
    [
      "Retrieve",
      `Fetch ${sample.evidence.manuals} documents, ${sample.evidence.timeSeries} trends`,
    ],
    ["Verify", `Run ${verification?.checks.length ?? 5} verifier checks`],
    ["Simulate", "Evaluate with process model"],
    [
      "Answer",
      verification?.pass
        ? "Provide grounded response"
        : revise
          ? "Abstain / revise"
          : "Abstain: verifier failed",
    ],
  ];
  // While the stage runs, the rollout walks its five actions on a 1.4 s beat.
  const active = running ? Math.floor(now / 1400) % (steps.length + 1) : steps.length;
  return (
    <ol className={styles.actions}>
      {steps.map(([name, detail], i) => (
        <li key={name} data-state={i < active ? "done" : i === active ? "active" : "todo"}>
          <span>{i + 1}</span>
          <div>
            <strong>{name}</strong>
            <small>{detail}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stage 4: teacher vs student
// ────────────────────────────────────────────────────────────────────────────────────────────

const LINE = /\d{1,2}"-[A-Z]{2,3}-\d{4}-[A-Z]\d[A-Z]/;

function TeacherStudent({
  teacher,
  student,
  teacherCheck,
  studentCheck,
  teacherInjected,
  studentInjected,
  register,
}: {
  readonly teacher: GroundedAnswer;
  readonly student: GroundedAnswer;
  readonly teacherCheck: Verification;
  readonly studentCheck: Verification;
  readonly teacherInjected?: readonly InjectedError[];
  readonly studentInjected?: readonly InjectedError[];
  readonly register: PlantRegister;
}) {
  const lines = new Set([...register.lines.values()].map((line) => line.number));
  const chips = (answer: GroundedAnswer, check: Verification) => {
    const byId = new Map(check.checks.map((c) => [c.id, c]));
    const citesPid = (answer.text.match(LINE) ?? []).some((line) => lines.has(line));
    return [
      ["Grounded", byId.get("grounding")!.pass && check.fabricated.length === 0],
      ["Correct tools", byId.get("topology")!.pass && byId.get("simulator")!.pass],
      ["Cites P&ID", citesPid],
    ] as const;
  };
  const block = (
    role: string,
    model: string,
    answer: GroundedAnswer,
    check: Verification,
    injected: readonly InjectedError[] | undefined,
  ) => (
    <div className={styles.bubble} data-role="model">
      <span className={styles.bubbleIcon}>
        <Icon name="robot" size={14} />
      </span>
      <div>
        <strong>
          {role} ({model}) · {check.overall.toFixed(2)}
        </strong>
        <p>{answer.text}</p>
        <span className={styles.chips}>
          {chips(answer, check).map(([name, ok]) => (
            <span key={name} className={styles.verdict} data-pass={ok || undefined}>
              {name} <Icon name={ok ? "check" : "cross"} size={11} />
            </span>
          ))}
        </span>
        {injected && injected.length > 0 && (
          <ul
            className={`${local.findings} ${local.rollout}`}
            aria-label={`${role} errors`}
          >
            {verifierFindings(injected, check).map((finding) => (
              <li key={finding.kind} data-caught={finding.caught || undefined}>
                {finding.summary}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
  return (
    <div className={styles.trace} tabIndex={0} aria-label="Teacher and student responses">
      {block("Teacher", "Qwen3-VL-32B", teacher, teacherCheck, teacherInjected)}
      <span className={styles.traceArrow} aria-hidden="true">
        ↓
      </span>
      {block("Student", "Qwen3-VL-8B", student, studentCheck, studentInjected)}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Header additions and stage 3 rollout findings
// ────────────────────────────────────────────────────────────────────────────────────────────

function ProvenanceLine({ provenance }: { readonly provenance: SampleProvenance }) {
  const sources = provenance.sources.map((s) => `${s.label}: ${s.value}`).join(" · ");
  const sep = (
    <span className={local.sep} aria-hidden="true">
      ·
    </span>
  );
  return (
    <p className={local.provenance} aria-label="Sample provenance" title={sources}>
      <span className={local.split} data-split={provenance.split}>
        {provenance.split}
      </span>
      {sep}
      <code>{provenance.shard}</code>
      {sep}
      <code>{provenance.sampleId}</code>
      {provenance.rolloutId && (
        <>
          {sep}
          <span>{provenance.rolloutId}</span>
        </>
      )}
    </p>
  );
}

function Countdown({
  seconds,
  period,
}: {
  readonly seconds: number;
  readonly period: number;
}) {
  const left = Math.max(0, Math.min(period, Math.ceil(seconds)));
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const share = period > 0 ? left / period : 0;
  return (
    <span
      className={local.countdown}
      role="img"
      aria-label={`Next sample in ${left} second${left === 1 ? "" : "s"}`}
      title={`Next sample in ${left} s`}
    >
      <svg viewBox="0 0 24 24" width={24} height={24} aria-hidden="true">
        <circle className={local.countdownTrack} cx={12} cy={12} r={radius} />
        <circle
          className={local.countdownArc}
          cx={12}
          cy={12}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - share)}
        />
      </svg>
      <span aria-hidden="true">{left}</span>
    </span>
  );
}

function RolloutFindings({
  policy,
  rolloutLabel,
}: {
  readonly policy: PolicyResult;
  readonly rolloutLabel: string | undefined;
}) {
  const findings = verifierFindings(policy.injected, policy.verification);
  return (
    <div className={local.rollout} role="group" aria-label="Rollout errors">
      <strong>Rollout{rolloutLabel ? ` · ${rolloutLabel}` : ""}</strong>
      {findings.length === 0 ? (
        <span className={local.clean}> · no policy errors in this rollout</span>
      ) : (
        <ul className={local.findings}>
          {findings.map((finding) => (
            <li key={finding.kind} data-caught={finding.caught || undefined}>
              {finding.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
