"use client";

/**
 * Execution architecture as four figures: the device mesh the applied configuration
 * describes, one GPU's HBM by owner, the data plane feeding the ranks, and the serving path
 * this page does not connect to.
 *
 * Everything follows the live step: the phase executing now comes from the same step frame
 * the run console plots (telemetry.frameAt / phaseAt), so the mesh links carry traffic
 * exactly while the console shows exposed collectives, the HBM slot holds the rollout KV pool
 * exactly while generation runs, and the prefetch queue drains exactly when the console shows
 * a data-loader stall.
 *
 * Grammar (ArchitectureFigure): stroke width = bandwidth; dashed moving = gradient traffic
 * (reduce-scatter); solid moving = forward traffic (parameter all-gather); hatched = frozen;
 * dotted = not connected.
 */

import { useId, useMemo, type CSSProperties } from "react";

import { BACKBONES, type RunConfig, type RunProfile } from "@/lib/modellab/config";
import { fabricOf } from "@/lib/modellab/hardware";
import { hbmPlan, type HbmOwner, type HbmPlan } from "@/lib/modellab/hbm";
import type { Stage } from "@/lib/modellab/stages";
import { PHASES, frameAt, phaseAt, type StepFrame } from "@/lib/modellab/telemetry";

import { Icon, type IconName } from "../icons";
import css from "./ExecutionDiagrams.module.css";

export interface ExecutionDiagramsProps {
  readonly stage: Stage;
  readonly step: number;
  readonly running: boolean;
  readonly config: RunConfig;
  readonly profile: RunProfile;
}

/** Phases in which ranks exchange shards over the fabric, and which way the traffic runs. */
const COLLECTIVE: Record<string, "gradient" | "forward"> = {
  comm: "gradient",
  update_actor: "gradient",
  forward: "forward",
  backward: "gradient",
  old_log_prob: "forward",
  ref: "forward",
  teacher: "forward",
};

const gb = (value: number) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Rollout tensor-parallel degree, as the planning profile sizes it for generation. */
function rolloutTensorParallel(config: RunConfig): number {
  const backbone = BACKBONES.find((item) => item.id === config.backbone) ?? BACKBONES[0]!;
  const weightsGb = backbone.params * 2;
  return weightsGb > 40 ? 4 : weightsGb > 16 ? 2 : 1;
}

export function ExecutionDiagrams({
  stage,
  step,
  running,
  config,
  profile,
}: ExecutionDiagramsProps) {
  const context = useMemo(() => ({ stage, profile, config }), [stage, profile, config]);
  const current = Math.floor(step);
  const frame = useMemo(
    () => frameAt(context, Math.min(stage.run.totalSteps, current + 1)),
    [context, current, stage.run.totalSteps],
  );
  const phase = frame.phases[phaseAt(frame, step - current).index];
  const traffic = running && phase ? COLLECTIVE[phase.id] : undefined;
  const plan = useMemo(
    () => hbmPlan(stage.id, config, profile, running ? phase?.id : undefined),
    [stage.id, config, profile, running, phase?.id],
  );

  return (
    <div className={css.grid}>
      <DeviceMesh
        stageId={stage.id}
        config={config}
        profile={profile}
        phaseLabel={running ? phase?.label : undefined}
        traffic={traffic}
        generating={running && phase?.id === "gen"}
      />
      <HbmStack plan={plan} phaseLabel={running ? phase?.label : undefined} />
      <DataPlane stage={stage} frame={frame} running={running} />
      <ServingPath />
    </div>
  );
}

// ── device mesh ────────────────────────────────────────────────────────────────────────────

const GPU = 22;
const GPU_GAP = 7;
const NODE_PAD = 11;
const NODE_GAP = 28;
const PER_ROW = 4;
/** Largest a GPU tile may render, px, so a one-node mesh does not balloon. */
const MAX_GPU_PX = 40;
/** Stroke width for a link of `gbps` GB/s: area-true (√) up to the fastest fabric. */
const linkWidth = (gBps: number) => 0.7 + 3.6 * Math.sqrt(Math.min(1, gBps / 900));

function DeviceMesh({
  stageId,
  config,
  profile,
  phaseLabel,
  traffic,
  generating,
}: {
  readonly stageId: Stage["id"];
  readonly config: RunConfig;
  readonly profile: RunProfile;
  readonly phaseLabel: string | undefined;
  readonly traffic: "gradient" | "forward" | undefined;
  readonly generating: boolean;
}) {
  const nodes = Math.max(1, config.nodes);
  const perNode = Math.max(1, config.gpusPerNode);
  const world = nodes * perNode;
  const fabric = fabricOf(profile.accelerator.id);
  const nvlinkGBps = fabric.intraGBps;
  const uplinkGBps = (fabric.gbps * fabric.nicsPerNode) / 8;
  const tp = stageId === "rl" ? Math.min(perNode, rolloutTensorParallel(config)) : 1;

  const gpuCols = Math.min(4, perNode);
  const gpuRows = Math.ceil(perNode / gpuCols);
  const nodeW = NODE_PAD * 2 + gpuCols * GPU + (gpuCols - 1) * GPU_GAP;
  const switchY = NODE_PAD + GPU + 11;
  const nodeH = gpuRows > 1 ? switchY + 11 + GPU + NODE_PAD : switchY + NODE_PAD;
  const cols = Math.min(PER_ROW, nodes);
  const rows = Math.ceil(nodes / cols);
  const spineY = 20;
  const top = nodes > 1 ? 48 : 18;
  const width = cols * nodeW + (cols - 1) * NODE_GAP + 40;
  const height = top + rows * nodeH + (rows - 1) * NODE_GAP + 26;
  const origin = (n: number) => ({
    x: 20 + (n % cols) * (nodeW + NODE_GAP),
    y: top + Math.floor(n / cols) * (nodeH + NODE_GAP),
  });
  const gpuAt = (g: number) => {
    const row = Math.floor(g / gpuCols);
    const col = g % gpuCols;
    return {
      x: NODE_PAD + col * (GPU + GPU_GAP),
      y: row === 0 ? NODE_PAD : switchY + 11,
      row,
    };
  };
  const nvW = linkWidth(nvlinkGBps);
  const ibW = linkWidth(uplinkGBps);

  const description = [
    `Device mesh: ${nodes} node${nodes > 1 ? "s" : ""} × ${perNode} ${profile.accelerator.name}, ${world} ranks in one FSDP2 full-shard group (data-parallel degree ${world}).`,
    `${fabric.intra} ${nvlinkGBps} GB/s per GPU through the node switch${nodes > 1 ? `; ${fabric.inter} ${fabric.nicsPerNode} × ${fabric.gbps} Gb/s, ${gb(uplinkGBps)} GB/s per node uplink` : ""}. Line width is bandwidth.`,
    tp > 1 ? `Rollout engine tensor-parallel groups of ${tp}.` : "",
    traffic
      ? `Now: ${traffic === "gradient" ? "gradient reduce-scatter" : "parameter all-gather"} in flight.`
      : "Links quiet.",
  ].join(" ");

  return (
    <figure className={css.card} data-area="topology">
      <figcaption className={css.caption}>
        <span>FIGURE 04C · DEVICE MESH</span>
        <code>
          {nodes}×{perNode} · DP {world}
          {tp > 1 ? ` · TP${tp}` : ""}
        </code>
      </figcaption>
      <div
        className={css.scroll}
        tabIndex={0}
        role="region"
        aria-label="Device mesh, scrollable"
      >
        <svg
          className={css.topology}
          data-traffic={traffic}
          data-generating={generating || undefined}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={description}
          style={{ maxWidth: `${Math.round((width * MAX_GPU_PX) / GPU)}px` }}
        >
          {/* FSDP2 full shard: every rank holds 1/world of each parameter, gradient and
              optimizer state, so the shard group is the whole mesh. */}
          <rect
            className={css.shardGroup}
            x={5}
            y={top - 9}
            width={width - 10}
            height={height - top - 4}
            rx={4}
          />
          <text className={css.svgLabel} x={width - 8} y={height - 5} textAnchor="end">
            FSDP2 shard ÷{world}
          </text>
          {nodes > 1 && (
            <>
              <rect
                className={css.spine}
                x={8}
                y={spineY - 3}
                width={width - 16}
                height={6}
                rx={1}
              />
              <text className={css.svgLabel} x={8} y={spineY - 7}>
                {fabric.inter}
              </text>
              <text className={css.svgLabel} x={width - 8} y={spineY - 7} textAnchor="end">
                {gb(uplinkGBps)} GB/s / node
              </text>
            </>
          )}
          {nodes > 1 &&
            Array.from({ length: nodes }, (_, n) => {
              const { x, y } = origin(n);
              const d =
                y === top
                  ? `M${x + nodeW / 2} ${spineY + 3}V${y}`
                  : `M${x - NODE_GAP / 2} ${spineY + 3}V${y + nodeH / 2}H${x}`;
              return <path key={`ib${n}`} className={css.ib} d={d} strokeWidth={ibW} />;
            })}
          {Array.from({ length: nodes }, (_, n) => {
            const { x, y } = origin(n);
            return (
              <g key={n} transform={`translate(${x} ${y})`}>
                <rect className={css.node} width={nodeW} height={nodeH} rx={3} />
                <rect
                  className={css.nvswitch}
                  x={NODE_PAD}
                  y={switchY - 2}
                  width={nodeW - NODE_PAD * 2}
                  height={4}
                />
                {tp > 1 &&
                  Array.from({ length: Math.ceil(perNode / tp) }, (_, t) => {
                    // A TP group spans consecutive local ranks; with four per row it is one
                    // row's worth.
                    const first = gpuAt(t * tp);
                    const last = gpuAt(Math.min(perNode, (t + 1) * tp) - 1);
                    return (
                      <rect
                        key={`tp${t}`}
                        className={css.tpGroup}
                        x={first.x - 3}
                        y={first.y - 3}
                        width={last.x - first.x + GPU + 6}
                        height={last.y - first.y + GPU + 6}
                        rx={2}
                      />
                    );
                  })}
                {Array.from({ length: perNode }, (_, g) => {
                  const { x: gx, y: gy, row } = gpuAt(g);
                  const rank = n * perNode + g;
                  return (
                    <g key={g}>
                      <line
                        className={css.nvlink}
                        x1={gx + GPU / 2}
                        x2={gx + GPU / 2}
                        y1={row === 0 ? gy + GPU : gy}
                        y2={switchY}
                        strokeWidth={nvW}
                      />
                      <rect
                        className={css.gpu}
                        x={gx}
                        y={gy}
                        width={GPU}
                        height={GPU}
                        rx={1.5}
                      />
                      <text
                        className={css.rank}
                        x={gx + GPU / 2}
                        y={gy + GPU / 2 + 3}
                        textAnchor="middle"
                      >
                        {rank}
                      </text>
                    </g>
                  );
                })}
                <text className={css.svgLabel} x={2} y={nodeH + 13}>
                  node-{String(n + 1).padStart(2, "0")}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={css.key} aria-hidden="true">
        <li>
          <svg viewBox="0 0 24 8">
            <path d="M0 4H24" className={css.keyLink} strokeWidth={nvW} />
          </svg>
          {fabric.intra} {nvlinkGBps} GB/s
        </li>
        {nodes > 1 && (
          <li>
            <svg viewBox="0 0 24 8">
              <path d="M0 4H24" className={css.keyLink} strokeWidth={ibW} />
            </svg>
            IB {gb(uplinkGBps)} GB/s
          </li>
        )}
        <li>
          <span className={css.keyShard} />
          shard
        </li>
        {tp > 1 && (
          <li>
            <span className={css.keyTp} />
            TP{tp}
          </li>
        )}
        <li className={css.phase} data-traffic={traffic}>
          {traffic === "gradient"
            ? "reduce-scatter ∇"
            : traffic === "forward"
              ? "all-gather W"
              : (phaseLabel ?? "paused").toLowerCase()}
        </li>
      </ul>
    </figure>
  );
}

// ── per-GPU HBM ────────────────────────────────────────────────────────────────────────────

const OWNER_FILL: Record<HbmOwner, string> = {
  frozen: "var(--ink-fill)",
  weights: "var(--series-1)",
  grads: "var(--series-2)",
  optimizer: "var(--series-4)",
  activations: "var(--series-3)",
  kv: "var(--series-6)",
};

function HbmStack({
  plan,
  phaseLabel,
}: {
  readonly plan: HbmPlan;
  readonly phaseLabel: string | undefined;
}) {
  // A url(#…) fragment must be a plain name; useId may contain colons.
  const hatch = `hatch-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const scale = Math.max(plan.capacityGb, plan.totalGb);
  const at = (value: number) => `${(Math.max(0, value) / scale) * 100}%`;
  const fixed = plan.segments.filter(
    (segment) => segment.id !== "activations" && segment.id !== "kv",
  );
  const slotFill = plan.segments.find((segment) =>
    plan.kvLive ? segment.id === "kv" : segment.id === "activations",
  )!;
  const headroom = Math.max(0, plan.capacityGb - plan.totalGb);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * plan.capacityGb);
  const kvSegment = plan.segments.find((segment) => segment.id === "kv")!;

  return (
    <figure className={css.card} data-area="memory">
      <figcaption className={css.caption}>
        <span>FIGURE 04D · HBM / GPU</span>
        <code className={css.verdict} data-fits={plan.fits ? "true" : "false"}>
          <i />
          {gb(plan.totalGb)} / {plan.capacityGb} GB
        </code>
      </figcaption>
      <div
        className={css.memory}
        role="img"
        aria-label={`Per-GPU HBM by owner: ${plan.segments
          .filter((segment) => segment.id !== "kv" && segment.id !== "activations")
          .map((segment) => `${segment.label} ${gb(segment.gb)} GB`)
          .join(
            ", ",
          )}; activation and KV slot ${gb(plan.slotGb)} GB${plan.kvDemandGb > 0 ? `, time-shared with the rollout KV cache (${gb(plan.kvDemandGb)} GB demand${plan.kvPreempting ? ", preempting" : ""})` : ", no KV cache in training"}; holding ${plan.kvLive ? "KV" : "activations"} now. Total ${gb(plan.totalGb)} of ${plan.capacityGb} GB, ${plan.fits ? "within" : "over"} the 92% planning limit.`}
      >
        <svg className={css.patterns} aria-hidden="true">
          <defs>
            <pattern
              id={hatch}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="5" className={css.hatchLine} />
            </pattern>
          </defs>
        </svg>
        <div className={css.bar}>
          {fixed.map((segment) => (
            <span
              key={segment.id}
              className={css.segment}
              data-owner={segment.id}
              style={
                {
                  width: at(segment.gb),
                  background: OWNER_FILL[segment.id],
                } as CSSProperties
              }
            >
              {segment.id === "frozen" && (
                <svg aria-hidden="true">
                  <rect width="100%" height="100%" fill={`url(#${hatch})`} />
                </svg>
              )}
            </span>
          ))}
          {/* The activation / KV slot: fixed width, filled by whichever owns it now. */}
          <span
            className={css.slot}
            data-kv={plan.kvLive || undefined}
            style={{ width: at(plan.slotGb) }}
          >
            <i
              style={{
                width: `${(slotFill.gb / Math.max(1e-9, plan.slotGb)) * 100}%`,
                background: OWNER_FILL[slotFill.id],
              }}
            />
          </span>
          {headroom > 0 && (
            <span className={css.headroom} style={{ width: at(headroom) }} />
          )}
          <i className={css.limit} style={{ left: at(plan.limitGb) }} />
          <i className={css.capacity} style={{ left: at(plan.capacityGb) }} />
        </div>
        <div className={css.axis} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ left: at(tick) }}>
              {Math.round(tick)}
            </span>
          ))}
        </div>
        <ul className={css.memoryKey} aria-hidden="true">
          {fixed.map((segment) => (
            <li key={segment.id} data-owner={segment.id}>
              <span style={{ background: OWNER_FILL[segment.id] }}>
                {segment.id === "frozen" && (
                  <svg>
                    <rect width="100%" height="100%" fill={`url(#${hatch})`} />
                  </svg>
                )}
              </span>
              {segment.label}
              <b>{gb(segment.gb)}</b>
            </li>
          ))}
          <li data-active={!plan.kvLive || undefined}>
            <span style={{ background: OWNER_FILL.activations }} />
            act
            <b>{gb(plan.slotGb)}</b>
          </li>
          <li
            data-active={plan.kvLive || undefined}
            data-empty={plan.kvDemandGb === 0 || undefined}
          >
            <span style={{ background: OWNER_FILL.kv }} />
            KV
            <b>
              {plan.kvDemandGb === 0
                ? "—"
                : plan.kvLive
                  ? gb(kvSegment.gb)
                  : `≤${gb(Math.min(plan.kvDemandGb, plan.slotGb))}`}
            </b>
          </li>
          <li>
            <span className={css.headroomSwatch} />
            free
            <b>{gb(headroom)}</b>
          </li>
        </ul>
        {plan.kvDemandGb > 0 && (
          <span className={css.slotState} data-kv={plan.kvLive || undefined}>
            slot · {plan.kvLive ? "KV" : "act"}
            {phaseLabel ? ` · ${phaseLabel.toLowerCase()}` : ""}
            {plan.kvPreempting ? " · preempt" : ""}
          </span>
        )}
      </div>
    </figure>
  );
}

// ── data plane ─────────────────────────────────────────────────────────────────────────────

const QUEUE_SLOTS = 8;

function DataPlane({
  stage,
  frame,
  running,
}: {
  readonly stage: Stage;
  readonly frame: StepFrame;
  readonly running: boolean;
}) {
  const nominal = PHASES[stage.id].find((phase) => phase.id === "data")?.share;
  const data = frame.phases.find((phase) => phase.id === "data");
  const share = data ? data.seconds / Math.max(1e-9, frame.stepSeconds) : undefined;
  // Queue depth ∝ nominal wait ÷ observed wait: full at the planned wait, draining as a stall
  // stretches the loader phase.
  const fill =
    nominal !== undefined && share !== undefined
      ? Math.min(1, nominal / Math.max(nominal, share))
      : 1;
  const filled = Math.round(fill * QUEUE_SLOTS);
  const stalled = filled < QUEUE_SLOTS - 1;
  const stages: readonly { id: string; label: string; icon: IconName }[] = [
    { id: "store", label: "object store", icon: "db" },
    { id: "workers", label: "loaders", icon: "table" },
    { id: "queue", label: "prefetch", icon: "table" },
    { id: "proc", label: "processor", icon: "gear" },
    { id: "ranks", label: "ranks", icon: "runtime" },
  ];
  return (
    <figure className={css.card} data-area="data">
      <figcaption className={css.caption}>
        <span>FIGURE 04E · DATA PLANE</span>
        <code>{share !== undefined ? `wait ${pct(share)}` : "rollout-bound"}</code>
      </figcaption>
      <div
        className={css.pipeline}
        role="img"
        aria-label={`Data plane: object storage, loader workers, prefetch queue, processor, training ranks. Prefetch queue ${filled} of ${QUEUE_SLOTS} batches${share !== undefined ? `; data-loader wait ${pct(share)} of the step` : "; prompts only, the step is bound by rollout generation"}${stalled ? "; input stall" : ""}.`}
        data-stalled={stalled ? "true" : undefined}
      >
        {stages.map((item) => (
          <div key={item.id} className={css.stage}>
            <div className={css.stageBody}>
              {item.id === "queue" ? (
                <span className={css.queue}>
                  {Array.from({ length: QUEUE_SLOTS }, (_, i) => (
                    <i key={i} data-full={i < filled ? "true" : undefined} />
                  ))}
                </span>
              ) : (
                <span
                  className={css.box}
                  data-running={item.id === "ranks" && running ? "true" : undefined}
                >
                  <Icon name={item.icon} size={14} />
                </span>
              )}
            </div>
            <span className={css.stageLabel}>{item.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// ── serving path ───────────────────────────────────────────────────────────────────────────

function ServingPath() {
  const steps: readonly (readonly [string, IconName])[] = [
    ["processor", "gear"],
    ["prefill", "play"],
    ["KV cache", "db"],
    ["decode", "next"],
  ];
  return (
    <figure className={css.card} data-area="serving">
      <figcaption className={css.caption}>
        <span>FIGURE 04F · SERVING</span>
        <code className={css.detached}>not connected</code>
      </figcaption>
      <div
        className={css.pipeline}
        data-detached="true"
        role="img"
        aria-label="Serving path, not connected here: processor, prefill, KV cache, decode."
      >
        {steps.map(([step, icon]) => (
          <div key={step} className={css.stage}>
            <div className={css.stageBody}>
              <span className={css.box}>
                <Icon name={icon} size={14} />
              </span>
            </div>
            <span className={css.stageLabel}>{step}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
