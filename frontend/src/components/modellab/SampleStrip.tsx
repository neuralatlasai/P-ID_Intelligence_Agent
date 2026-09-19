"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import type { PlantRegister } from "@/lib/canvas/engineering";
import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import { GROUP_SIZE } from "@/lib/modellab/config";
import {
  verifierFindings,
  type Finding,
  type InjectedError,
  type PolicyErrorKind,
  type SampleProvenance,
} from "@/lib/modellab/policy";
import { stepAt } from "@/lib/modellab/run";
import type {
  CheckId,
  GroundedAnswer,
  LabSample,
  Verification,
} from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";
import { frameAt, type StepFrame } from "@/lib/modellab/telemetry";

import { useRunClock } from "./flow/RunClockContext";
import { groupAdvantages } from "./flow/stepFlow";
import { Icon, type IconName } from "./icons";
import styles from "./ModelLab.module.css";
import local from "./SampleStrip.module.css";
import { MODALITY_COLOUR, pidCropWindow, textTokens } from "./visual/conversion";
import {
  KD_TEMPERATURE,
  claimsOf,
  groupRewards,
  kdDistributions,
  type ClaimKind,
} from "./visual/sampleVisuals";

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

/** The run's step frame, when the strip sits inside the run clock; undefined in isolation. */
function useStepFrame(now: number): StepFrame | undefined {
  const clock = useRunClock();
  const step = clock && !clock.blocked ? stepAt(clock.control, clock.stage.run, now) : 0;
  const completed = Math.max(1, Math.floor(step));
  return useMemo(
    () =>
      clock
        ? frameAt(
            { stage: clock.stage, profile: clock.profile, config: clock.config },
            completed,
          )
        : undefined,
    [clock, completed],
  );
}

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
  const frame = useStepFrame(now);
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
    <Panel key="image" title={stage.id === "sft" ? "Asset photo" : "Field RGB"}>
      <FieldImage
        sample={sample}
        label={label}
        variant={stage.id === "sft" ? "red" : "blue"}
        zoomable={stage.id === "rl"}
      />
    </Panel>,
    <Panel key="pid" title="P&ID crop" note={stage.id === "sft" ? "linked" : undefined}>
      <PidCrop
        sample={sample}
        drawing={drawing}
        imageUrl={imageUrl}
        label={label}
        line={sample.line?.number}
      />
    </Panel>,
  ];

  if (stage.id === "pretraining") {
    panels.push(
      <Panel key="3d" title="3D twin" note="procedural">
        <DeviceModel fieldClass={sample.fieldClass} label={label} />
      </Panel>,
      <Panel key="graph" title="Topology" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="equipment" />
      </Panel>,
    );
  } else if (stage.id === "sft") {
    panels.push(
      <Panel key="evidence" title="Evidence map">
        <EvidenceMap sample={sample} label={label} />
      </Panel>,
      <Panel key="trace" title="Response grounding" note="loss mask" wide>
        {answer && <ResponseGrounding answer={answer} sample={sample} />}
      </Panel>,
    );
  } else if (stage.id === "rl") {
    panels.push(
      <Panel key="graph" title="Topology" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="none" />
      </Panel>,
      <Panel key="verifier" title="Verifier" note={rolloutLabel ?? provenance?.rolloutId}>
        <div
          className={local.verifierPanel}
          tabIndex={0}
          role="region"
          aria-label="Verifier results, scrollable"
        >
          {rlVerification && (
            <VerifierMatrix
              verification={rlVerification}
              findings={
                policy ? verifierFindings(policy.injected, policy.verification) : []
              }
            />
          )}
          {frame?.rl && <RolloutGroup frame={frame} />}
        </div>
      </Panel>,
      <Panel key="actions" title="Action chain" narrow>
        <ActionChain
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
      <Panel key="graph" title="Topology" note={`${sample.joinedCount} joined`}>
        <Topology sample={sample} onChoose={choose} legend="process" />
      </Panel>,
      <Panel key="compare" title="Teacher → student" note={`T ${KD_TEMPERATURE}`} wide>
        {teacherAnswer && studentAnswer && teacherCheck && studentCheck && (
          <TeacherStudent
            teacher={teacherAnswer}
            student={studentAnswer}
            teacherCheck={teacherCheck}
            studentCheck={studentCheck}
            teacherInjected={teacherPolicy?.injected}
            studentInjected={studentPolicy?.injected}
            register={register}
            frame={frame}
            sampleKey={sample.nodeId}
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
          <span className={styles.technicalLabel} aria-hidden="true">
            IN
          </span>
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
      <figcaption>
        <span className={local.genChip}>gen</span> {sample.fieldClass}
      </figcaption>
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

/**
 * The located symbol on the sheet, with every other symbol in the window drawn as a
 * detection and the sample's graph neighbours at the related weight.
 */
function PidCrop({
  sample,
  drawing,
  imageUrl,
  label,
  line,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly imageUrl: string;
  readonly label: string;
  readonly line: string | undefined;
}) {
  const node = sample.node;
  const window = pidCropWindow(node);
  const span = window.height;
  const pad = Math.max(node.width, node.height) * 0.35;
  const related = useMemo(
    () => new Set(sample.neighbours.map((neighbour) => neighbour.id)),
    [sample.neighbours],
  );
  const nearby = useMemo(
    () =>
      drawing.nodes.filter(
        (other: DrawingNode) =>
          other.positioned !== false &&
          other.id !== node.id &&
          Math.abs(other.x - node.x) < window.width / 2 + other.width / 2 &&
          Math.abs(other.y - node.y) < window.height / 2 + other.height / 2,
      ),
    [drawing, node, window.width, window.height],
  );
  const relatedCount = nearby.filter((other) => related.has(other.id)).length;
  return (
    <Link
      href={canvasHref(sample.nodeId)}
      className={styles.pidCrop}
      title="Open this symbol on the canvas"
    >
      <svg
        viewBox={`${window.x} ${window.y} ${window.width} ${window.height}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`${label} as drawn on the P&ID${line ? `, line ${line}` : ""}; ${nearby.length} other symbols in view, ${relatedCount} of them graph neighbours`}
      >
        <rect
          x={window.x}
          y={window.y}
          width={window.width}
          height={window.height}
          fill="var(--bg-void)"
        />
        {/* Normalised to ink-on-void; the class sits on the image alone so the detection
            marks above it are not inverted with it. */}
        <image
          className="engineeringRaster"
          href={imageUrl}
          width={drawing.width}
          height={drawing.height}
        />
        {nearby.map((other) => (
          <rect
            key={other.id}
            className={local.detect}
            data-related={related.has(other.id) || undefined}
            x={other.x - other.width / 2}
            y={other.y - other.height / 2}
            width={other.width}
            height={other.height}
            style={{ strokeWidth: span / 160 }}
          />
        ))}
        <rect
          x={node.x - node.width / 2 - pad}
          y={node.y - node.height / 2 - pad}
          width={node.width + pad * 2}
          height={node.height + pad * 2}
          fill="none"
          stroke="var(--overlay-selected)"
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

/**
 * Neighbour groups are categories, not states, so they take the ordered categorical family
 * in the order the legend lists them — never a status colour.
 */
const GROUP_COLOUR = {
  equipment: "var(--series-1)",
  instrument: "var(--series-2)",
  process: "var(--series-3)",
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
// Stage 2: evidence map and response grounding
// ────────────────────────────────────────────────────────────────────────────────────────────

function EvidenceMap({
  sample,
  label,
}: {
  readonly sample: LabSample;
  readonly label: string;
}) {
  // Six evidence classes: categories, so they take the categorical family in list order.
  const items: {
    name: string;
    count: number;
    icon: IconName;
    href: string;
    x: number;
    y: number;
  }[] = [
    {
      name: "Field Image",
      count: sample.evidence.fieldImages,
      icon: "canvas",
      href: canvasHref(sample.nodeId),
      x: 30,
      y: 14,
    },
    {
      name: "P&ID",
      count: sample.evidence.pid,
      icon: "reports",
      href: canvasHref(sample.nodeId),
      x: 70,
      y: 14,
    },
    {
      name: "3D Twin",
      count: sample.evidence.twin,
      icon: "cube",
      href: canvasHref(sample.nodeId, "Twin"),
      x: 80,
      y: 46,
    },
    {
      name: "Manuals",
      count: sample.evidence.manuals,
      icon: "book",
      href: canvasHref(sample.nodeId, "Files"),
      x: 70,
      y: 78,
    },
    {
      name: "Time-series",
      count: sample.evidence.timeSeries,
      icon: "monitoring",
      href: canvasHref(sample.nodeId),
      x: 30,
      y: 78,
    },
    {
      name: "Graph Topology",
      count: sample.evidence.graph,
      icon: "graph",
      href: canvasHref(sample.nodeId, "Assets"),
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
      {items.map((item, index) => (
        <Link
          key={item.name}
          href={item.href}
          className={styles.evidenceNode}
          style={{
            left: `${item.x}%`,
            top: `${item.y}%`,
            color: `var(--series-${index + 1})`,
          }}
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

/** Evidence kinds take the colour of the modality lane they come from. */
const CLAIM_COLOUR: Record<ClaimKind, string> = {
  "P&ID": MODALITY_COLOUR.drawing,
  Trend: MODALITY_COLOUR.telemetry,
  Procedure: MODALITY_COLOUR.documents,
  Topology: MODALITY_COLOUR.topology,
};

const CLAIM_ICON: Record<ClaimKind, IconName> = {
  "P&ID": "reports",
  Trend: "monitoring",
  Procedure: "file",
  Topology: "graph",
};

/** Reveal a count progressively, as a streamed answer arrives; instant under reduced motion. */
function useReveal(total: number, key: string): number {
  const [shown, setShown] = useState(total);
  useEffect(() => {
    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    let count = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restart the reveal for new text
    setShown(0);
    const timer = window.setInterval(() => {
      count += 1;
      setShown(Math.min(total, count));
      if (count >= total) window.clearInterval(timer);
    }, 24);
    return () => window.clearInterval(timer);
  }, [total, key]);
  return Math.min(total, shown);
}

/**
 * The SFT example as its loss mask sees it: the instruction (−100, no loss) and the response
 * split into its claims, each a span of tokens coloured by the evidence it is grounded in and
 * linked to that evidence. Tokens stream in as the response is decoded.
 */
function ResponseGrounding({
  answer,
  sample,
}: {
  readonly answer: GroundedAnswer;
  readonly sample: LabSample;
}) {
  const claims = claimsOf(answer);
  const prompt = textTokens(answer.question);
  const response = claims.reduce((sum, claim) => sum + claim.tokens, 0);
  const total = Math.max(1, prompt + response);
  const shown = useReveal(response, answer.text);
  const hrefFor: Record<ClaimKind, string> = {
    "P&ID": canvasHref(sample.nodeId),
    Trend: canvasHref(sample.nodeId),
    Procedure: canvasHref(sample.nodeId, "Files"),
    Topology: canvasHref(sample.nodeId, "Assets"),
  };
  const maxClaim = Math.max(1, ...claims.map((claim) => claim.tokens));
  const starts = claims.map((_, i) =>
    claims.slice(0, i).reduce((sum, claim) => sum + claim.tokens, 0),
  );
  return (
    <div className={local.grounding} aria-label="Reasoning trace" role="group">
      <p className="srOnly">
        User: {answer.question} Model: {answer.text}
      </p>
      <div className={local.seq} aria-hidden="true">
        <span className={local.seqRole}>x</span>
        <span className={local.seqTrack}>
          <i
            className={local.masked}
            style={{ flexGrow: prompt }}
            title={`Instruction · ${prompt} tokens · label −100`}
          />
          {claims.map((claim, i) => {
            const filled = Math.max(0, Math.min(1, (shown - starts[i]!) / claim.tokens));
            return (
              <i
                key={i}
                className={local.claimSpan}
                style={
                  {
                    flexGrow: claim.tokens,
                    "--claim": CLAIM_COLOUR[claim.kind],
                    "--fill": `${(filled * 100).toFixed(1)}%`,
                  } as CSSProperties
                }
                title={`${claim.kind} · ${claim.tokens} tokens · ${claim.text}`}
              />
            );
          })}
        </span>
        <span className={local.seqRole}>L</span>
        <span className={local.seqScale}>
          <b style={{ flexGrow: prompt }}>−100 · {prompt}</b>
          <b style={{ flexGrow: response }}>CE · {response}</b>
        </span>
      </div>
      <ol className={local.claims}>
        {claims.map((claim, i) => (
          <li key={i} style={{ "--claim": CLAIM_COLOUR[claim.kind] } as CSSProperties}>
            <Link
              href={hrefFor[claim.kind]}
              className={local.claimCite}
              title={claim.text}
              aria-label={`${claim.kind}: ${claim.text}`}
            >
              <Icon name={CLAIM_ICON[claim.kind]} size={12} />
              <span>{claim.kind}</span>
            </Link>
            <span className={local.claimBar} aria-hidden="true">
              <i style={{ width: `${(claim.tokens / maxClaim) * 100}%` }} />
            </span>
            <code aria-hidden="true">{claim.tokens}</code>
          </li>
        ))}
      </ol>
      <span className={local.seqFoot} aria-hidden="true">
        L {total} · fθ
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stage 3: verifier matrix, rollout group and action chain
// ────────────────────────────────────────────────────────────────────────────────────────────

const PASS_MARK = 0.7;

const CHECK_OF_ERROR: Record<PolicyErrorKind, CheckId | undefined> = {
  hallucination: "grounding",
  wrongConnection: "topology",
  staleReading: "simulator",
  missingCitation: "citation",
  wrongLine: "grounding",
};

const ERROR_CODE: Record<PolicyErrorKind, string> = {
  hallucination: "HAL",
  wrongConnection: "CON",
  staleReading: "STL",
  missingCitation: "CIT",
  wrongLine: "LIN",
};

/**
 * Checks × (weight, score against the 0.70 pass mark, verdict, injected policy errors). Every
 * check is a gate: the overall verdict fails when any one fails, whatever the weighted score.
 */
function VerifierMatrix({
  verification,
  findings,
}: {
  readonly verification: Verification;
  readonly findings: readonly Finding[];
}) {
  const byCheck = new Map<CheckId, Finding[]>();
  for (const finding of findings) {
    const id = CHECK_OF_ERROR[finding.kind];
    if (id) byCheck.set(id, [...(byCheck.get(id) ?? []), finding]);
  }
  const gates = verification.checks.filter((check) => !check.pass);
  const verdict = verification.pass
    ? "pass"
    : verification.fabricated.length > 0
      ? "fabricated"
      : gates.length > 0
        ? `gate ×${gates.length}`
        : "< 0.70";
  return (
    <table className={local.matrix}>
      <thead>
        <tr>
          <th scope="col">
            <span className="srOnly">Check</span>
          </th>
          <th scope="col">w</th>
          <th scope="col">score · 0.70</th>
          <th scope="col">
            <span className="srOnly">Verdict</span>
          </th>
          <th scope="col" title="Injected policy errors: filled caught, hollow missed">
            err
          </th>
        </tr>
      </thead>
      <tbody>
        {verification.checks.map((check) => {
          const errors = byCheck.get(check.id) ?? [];
          return (
            <tr key={check.id} data-pass={check.pass || undefined} title={check.detail}>
              <th scope="row">{check.label.split(" ")[0]}</th>
              <td className={local.num}>{check.weight.toFixed(2)}</td>
              <td>
                <ScoreBar score={check.score} pass={check.pass} />
              </td>
              <td>
                <span className={styles.passMark} data-pass={check.pass || undefined}>
                  <Icon name={check.pass ? "check" : "cross"} size={11} />
                </span>
                <span className="srOnly">{check.pass ? "Pass" : "Fail"}</span>
              </td>
              <td className={local.errors}>
                {errors.map((finding) => (
                  <span
                    key={finding.kind}
                    className={local.errorMark}
                    data-caught={finding.caught || undefined}
                    title={finding.summary}
                  >
                    {ERROR_CODE[finding.kind]}
                    <span className="srOnly">
                      {finding.caught ? " caught" : " missed"}: {finding.summary}
                    </span>
                  </span>
                ))}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr data-pass={verification.pass || undefined} className={local.overallRow}>
          <th scope="row">
            Overall<span className="srOnly"> verifier result</span>
          </th>
          <td />
          <td>
            <ScoreBar score={verification.overall} pass={verification.pass} />
          </td>
          <td>
            <span className={styles.passMark} data-pass={verification.pass || undefined}>
              <Icon name={verification.pass ? "check" : "cross"} size={11} />
            </span>
          </td>
          <td className={local.verdict} data-pass={verification.pass || undefined}>
            {verdict}
          </td>
        </tr>
        {verification.fabricated.length > 0 && (
          <tr>
            <td colSpan={5} className={local.fabricated}>
              {verification.fabricated.map((tag) => (
                <code key={tag} title="Fabricated: not in the register">
                  ✕ {tag}
                </code>
              ))}
            </td>
          </tr>
        )}
      </tfoot>
    </table>
  );
}

function ScoreBar({ score, pass }: { readonly score: number; readonly pass: boolean }) {
  return (
    <span className={local.score} data-pass={pass || undefined}>
      <span className={local.scoreTrack} aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />
        <b style={{ left: `${PASS_MARK * 100}%` }} />
      </span>
      <code>{score.toFixed(2)}</code>
    </span>
  );
}

/**
 * The prompt group of the last completed step: G completion rewards and their group-relative
 * advantages Â = (r − mean) / std — the same draw the architecture figure's advantage lanes
 * use, so the two agree at every step.
 */
function RolloutGroup({ frame }: { readonly frame: StepFrame }) {
  const rl = frame.rl!;
  const rewards = groupRewards(frame.step, rl.scoreMean, rl.zeroVarianceGroups, GROUP_SIZE);
  const advantages = groupAdvantages(
    frame.step,
    rl.scoreMean,
    rl.zeroVarianceGroups,
    GROUP_SIZE,
  );
  const flat = advantages.every((a) => a === 0);
  const W = 200;
  const colW = W / GROUP_SIZE;
  const rTop = 4;
  const rH = 30;
  const aMid = 62;
  const aH = 14;
  const maxA = Math.max(1, ...advantages.map((a) => Math.abs(a)));
  const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  return (
    <figure className={local.group}>
      <svg
        viewBox={`-26 0 ${W + 30} 82`}
        role="img"
        aria-label={`Prompt group at step ${frame.step}: ${GROUP_SIZE} completions, rewards ${rewards
          .map((r) => r.toFixed(2))
          .join(
            ", ",
          )}; advantages ${advantages.map((a) => a.toFixed(2)).join(", ")}${flat ? "; zero-variance group, no learning signal" : ""}`}
      >
        <text className={local.axisLabel} x={-4} y={rTop + rH / 2 + 3} textAnchor="end">
          r
        </text>
        <text className={local.axisLabel} x={-4} y={aMid + 3} textAnchor="end">
          Â
        </text>
        <line className={local.baseline} x1={0} x2={W} y1={rTop + rH} y2={rTop + rH} />
        <line
          className={local.meanLine}
          x1={0}
          x2={W}
          y1={rTop + rH * (1 - mean)}
          y2={rTop + rH * (1 - mean)}
        />
        <line className={local.baseline} x1={0} x2={W} y1={aMid} y2={aMid} />
        {rewards.map((reward, k) => {
          const a = advantages[k] ?? 0;
          const h = (Math.abs(a) / maxA) * aH;
          return (
            <g key={k}>
              <rect
                className={local.reward}
                x={k * colW + 3}
                y={rTop + rH * (1 - reward)}
                width={colW - 6}
                height={rH * reward}
              />
              <rect
                className={local.advantage}
                data-negative={a < 0 || undefined}
                x={k * colW + 3}
                y={a >= 0 ? aMid - h : aMid}
                width={colW - 6}
                height={Math.max(flat ? 0 : 0.6, h)}
              />
            </g>
          );
        })}
      </svg>
      <figcaption aria-hidden="true">
        G {GROUP_SIZE} · step {frame.step.toLocaleString("en-US")}
        {flat ? " · σ 0" : ""}
      </figcaption>
    </figure>
  );
}

function ActionChain({
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
  const answered = verification?.pass ?? false;
  const steps: readonly (readonly [string, string, string])[] = [
    ["Observe", sample.nodeId, `Analyze image and P&ID (${sample.nodeId})`],
    [
      "Retrieve",
      `${sample.evidence.manuals}d · ${sample.evidence.timeSeries}ts`,
      `Fetch ${sample.evidence.manuals} documents, ${sample.evidence.timeSeries} trends`,
    ],
    [
      "Verify",
      `${verification?.checks.length ?? 5} chk`,
      `Run ${verification?.checks.length ?? 5} verifier checks`,
    ],
    ["Simulate", "proc", "Evaluate with process model"],
    [
      "Answer",
      answered ? "✓" : revise ? "revise" : "abstain",
      answered
        ? "Provide grounded response"
        : revise
          ? "Abstain / revise"
          : "Abstain: verifier failed",
    ],
  ];
  // While the stage runs, the rollout walks its five actions on a 1.4 s beat.
  const active = running ? Math.floor(now / 1400) % (steps.length + 1) : steps.length;
  return (
    <ol className={local.chain}>
      {steps.map(([name, value, detail], i) => (
        <li
          key={name}
          data-state={i < active ? "done" : i === active ? "active" : "todo"}
          data-outcome={i === steps.length - 1 ? (answered ? "pass" : "fail") : undefined}
          title={detail}
        >
          <span className={local.chainIndex}>{i + 1}</span>
          <strong>{name}</strong>
          <code>{value}</code>
          <span className="srOnly">{detail}</span>
        </li>
      ))}
    </ol>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stage 4: teacher vs student
// ────────────────────────────────────────────────────────────────────────────────────────────

const LINE = /\d{1,2}"-[A-Z]{2,3}-\d{4}-[A-Z]\d[A-Z]/;

/**
 * The distillation example: the next-token distributions the KL term compares (teacher
 * outlined — frozen — student solid, top-8 at T = 2, one response position that advances with
 * the step), then both rollouts through the same checks.
 */
function TeacherStudent({
  teacher,
  student,
  teacherCheck,
  studentCheck,
  teacherInjected,
  studentInjected,
  register,
  frame,
  sampleKey,
}: {
  readonly teacher: GroundedAnswer;
  readonly student: GroundedAnswer;
  readonly teacherCheck: Verification;
  readonly studentCheck: Verification;
  readonly teacherInjected?: readonly InjectedError[];
  readonly studentInjected?: readonly InjectedError[];
  readonly register: PlantRegister;
  readonly frame: StepFrame | undefined;
  readonly sampleKey: string;
}) {
  const lines = new Set([...register.lines.values()].map((line) => line.number));
  const rows = (answer: GroundedAnswer, check: Verification) => {
    const byId = new Map(check.checks.map((c) => [c.id, c]));
    const citesPid = (answer.text.match(LINE) ?? []).some((line) => lines.has(line));
    return [
      ["Grounded", byId.get("grounding")!.pass && check.fabricated.length === 0],
      ["Correct tools", byId.get("topology")!.pass && byId.get("simulator")!.pass],
      ["Cites P&ID", citesPid],
    ] as const;
  };
  const teacherRows = rows(teacher, teacherCheck);
  const studentRows = rows(student, studentCheck);
  const teacherFindings = teacherInjected
    ? verifierFindings(teacherInjected, teacherCheck)
    : [];
  const studentFindings = studentInjected
    ? verifierFindings(studentInjected, studentCheck)
    : [];

  const length = Math.max(1, textTokens(student.text));
  const position = frame ? frame.step % length : 0;
  const kl = frame?.klTerm;
  const dist = useMemo(
    () => (kl === undefined ? undefined : kdDistributions(sampleKey, position, kl)),
    [sampleKey, position, kl],
  );

  const errorCell = (findings: readonly Finding[]) =>
    findings.length === 0 ? (
      <span className={local.muted}>0</span>
    ) : (
      findings.map((finding) => (
        <span
          key={finding.kind}
          className={local.errorMark}
          data-caught={finding.caught || undefined}
          title={finding.summary}
        >
          {ERROR_CODE[finding.kind]}
          <span className="srOnly">
            {finding.caught ? " caught" : " missed"}: {finding.summary}
          </span>
        </span>
      ))
    );

  return (
    <div className={local.kd} role="group" aria-label="Teacher and student responses">
      <p className="srOnly">
        Teacher Qwen3-VL-32B: {teacher.text} Student Qwen3-VL-8B: {student.text}
      </p>
      {dist && kl !== undefined && (
        <TokenBars
          teacher={dist.teacher}
          student={dist.student}
          kl={kl}
          position={position}
          length={length}
        />
      )}
      <table className={local.matrix} data-compact>
        <thead>
          <tr>
            <th scope="col">
              <span className="srOnly">Check</span>
            </th>
            <th scope="col" title="Teacher · Qwen3-VL-32B · frozen">
              <span className={local.modelKey} data-role="teacher" aria-hidden="true" />
              fT <small>32B</small>
            </th>
            <th scope="col" title="Student · Qwen3-VL-8B">
              <span className={local.modelKey} data-role="student" aria-hidden="true" />
              fS <small>8B</small>
            </th>
          </tr>
        </thead>
        <tbody>
          {teacherRows.map(([name, ok], i) => {
            const studentOk = studentRows[i]![1];
            return (
              <tr key={name}>
                <th scope="row">{name}</th>
                {[ok, studentOk].map((pass, j) => (
                  <td key={j}>
                    <span className={styles.passMark} data-pass={pass || undefined}>
                      <Icon name={pass ? "check" : "cross"} size={11} />
                    </span>
                    <span className="srOnly">{pass ? "Pass" : "Fail"}</span>
                  </td>
                ))}
              </tr>
            );
          })}
          <tr>
            <th scope="row">Score</th>
            <td>
              <ScoreBar score={teacherCheck.overall} pass={teacherCheck.pass} />
            </td>
            <td>
              <ScoreBar score={studentCheck.overall} pass={studentCheck.pass} />
            </td>
          </tr>
          <tr>
            <th scope="row">err</th>
            <td className={local.errors}>{errorCell(teacherFindings)}</td>
            <td className={local.errors}>{errorCell(studentFindings)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TokenBars({
  teacher,
  student,
  kl,
  position,
  length,
}: {
  readonly teacher: readonly number[];
  readonly student: readonly number[];
  readonly kl: number;
  readonly position: number;
  readonly length: number;
}) {
  const W = 300;
  const H = 70;
  const top = Math.max(...teacher, ...student, 0.01);
  const colW = W / teacher.length;
  const barW = (colW - 6) / 2;
  return (
    <figure className={local.tokens}>
      <figcaption aria-hidden="true">
        <span>
          <i className={local.modelKey} data-role="teacher" />p<sub>T</sub>
        </span>
        <span>
          <i className={local.modelKey} data-role="student" />p<sub>S</sub>
        </span>
        <code>
          pos {position + 1}/{length} · KL {kl.toFixed(3)}
        </code>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H + 12}`}
        role="img"
        aria-label={`Top-${teacher.length} next-token distributions at response position ${position + 1} of ${length}, temperature ${KD_TEMPERATURE}: teacher ${teacher
          .map((p) => p.toFixed(2))
          .join(
            ", ",
          )}; student ${student.map((p) => p.toFixed(2)).join(", ")}; forward KL ${kl.toFixed(3)}`}
      >
        <line className={local.baseline} x1={0} x2={W} y1={H} y2={H} />
        {teacher.map((p, i) => {
          const q = student[i] ?? 0;
          const x = i * colW + 3;
          return (
            <g key={i}>
              <rect
                className={local.teacherBar}
                x={x}
                y={H - (p / top) * H}
                width={barW}
                height={(p / top) * H}
              />
              <rect
                className={local.studentBar}
                x={x + barW + 1}
                y={H - (q / top) * H}
                width={barW}
                height={(q / top) * H}
              />
              <text className={local.axisLabel} x={x + barW} y={H + 10} textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Header additions
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
