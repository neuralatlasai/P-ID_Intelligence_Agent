"use client";

import { useState, type CSSProperties } from "react";

import {
  gpuTelemetry,
  HOT_TEMP_C,
  type GpuSample,
  type NodeTelemetry,
} from "@/lib/modellab/hardware";

import { Card } from "./Cards";
import styles from "./HardwareCard.module.css";
import type { LiveCardProps } from "./live";

export type HardwareCardProps = LiveCardProps;

type Metric = "util" | "temp" | "hbm";

/*
 * One heatmap, three layers. Each layer is a magnitude, so it takes the five-step sequential
 * scale (dim = low, bright = high); state is the only colour: the rank the incident timeline
 * names as a straggler takes a degraded ring, a GPU above the thermal band a down ring.
 */
const LAYERS: Record<
  Metric,
  {
    readonly label: string;
    readonly unit: string;
    /** Upper bounds of scale steps 1–4; above the last is step 5. */
    readonly steps: readonly [number, number, number, number];
    readonly read: (gpu: GpuSample) => number;
    readonly format: (value: number) => string;
  }
> = {
  util: {
    label: "SM util",
    unit: "%",
    steps: [25, 50, 75, 90],
    read: (gpu) => gpu.utilPct,
    format: (value) => value.toFixed(0),
  },
  temp: {
    label: "temp",
    unit: "°C",
    steps: [45, 60, 70, HOT_TEMP_C - 1],
    read: (gpu) => gpu.tempC,
    format: (value) => value.toFixed(0),
  },
  hbm: {
    label: "HBM",
    unit: "GB",
    steps: [0.5, 0.7, 0.85, 0.92],
    read: (gpu) => gpu.memUsedGb / gpu.memTotalGb,
    format: (value) => (value * 100).toFixed(0),
  },
};

const stepOf = (steps: readonly number[], value: number) =>
  1 + steps.filter((bound) => value >= bound).length;

const nodeName = (index: number) => `node-${String(index + 1).padStart(2, "0")}`;

function describeGpu(gpu: GpuSample): string {
  return `rank ${gpu.rank}, ${nodeName(gpu.node)} GPU ${gpu.gpu}: SM ${gpu.utilPct.toFixed(0)}%, ${gpu.tempC}°C, HBM ${gpu.memUsedGb.toFixed(1)} of ${gpu.memTotalGb} GB, ${gpu.powerW} W${gpu.straggler ? ", straggler" : ""}${gpu.hot ? ", hot" : ""}`;
}

function NodeRow({
  node,
  metric,
}: {
  readonly node: NodeTelemetry;
  readonly metric: Metric;
}) {
  const layer = LAYERS[metric];
  return (
    <div className={styles.row} role="row">
      <span className={styles.nodeName} role="rowheader">
        {node.name}
      </span>
      <span
        className={styles.cells}
        role="none"
        style={{ "--gpus": node.gpus.length } as CSSProperties}
      >
        {node.gpus.map((gpu) => {
          const value = layer.read(gpu);
          const step = stepOf(layer.steps, value);
          return (
            <span
              key={gpu.gpu}
              role="cell"
              className={styles.cell}
              data-step={step}
              data-straggler={gpu.straggler || undefined}
              data-hot={gpu.hot || undefined}
              style={{ background: `var(--scale-${step})` }}
              title={describeGpu(gpu)}
              aria-label={describeGpu(gpu)}
            >
              <b aria-hidden="true">{layer.format(value)}</b>
              <small aria-hidden="true">r{gpu.rank}</small>
            </span>
          );
        })}
      </span>
      <span
        className={styles.nodePower}
        role="cell"
        aria-label={`${node.name} board power`}
      >
        {(node.powerW / 1000).toFixed(1)}
        <small>kW</small>
      </span>
    </div>
  );
}

export function HardwareCard({
  stage,
  step,
  now,
  running,
  config,
  profile,
}: HardwareCardProps) {
  const [metric, setMetric] = useState<Metric>("util");
  // The straggler is read from the run's incident timeline at this step — the incident the
  // console's step-time chart marks and its log reports.
  const telemetry = gpuTelemetry(profile, config, stage.run.stepsPerSecond, running, now, {
    stage,
    step,
  });
  const { interconnect, straggler, stragglerIncident, hotSpot } = telemetry;
  const layer = LAYERS[metric];
  const trafficShare =
    interconnect.linkGbps > 0 ? interconnect.trafficGbps / interconnect.linkGbps : 0;

  return (
    <Card
      title="Cluster telemetry"
      icon="monitoring"
      className={styles.card}
      aside={
        <span className={styles.simChip}>
          <i aria-hidden="true" />
          Simulated
        </span>
      }
    >
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.fig}>FIGURE 04I · GPU HEATMAP</span>
          <div className={styles.segmented} role="group" aria-label="Heatmap layer">
            {(Object.keys(LAYERS) as Metric[]).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={metric === id}
                onClick={() => setMetric(id)}
              >
                {LAYERS[id].label}
              </button>
            ))}
          </div>
        </div>

        <dl className={styles.stats}>
          <div>
            <dt>SM</dt>
            <dd>
              {telemetry.avgUtilPct.toFixed(0)}
              <small>%</small>
            </dd>
          </div>
          <div>
            <dt>max</dt>
            <dd>
              {telemetry.maxTempC}
              <small>°C</small>
            </dd>
          </div>
          <div>
            <dt>board</dt>
            <dd>
              {telemetry.powerKw.toFixed(1)}
              <small>kW</small>
            </dd>
          </div>
        </dl>

        <div
          className={styles.grid}
          role="table"
          aria-label={`GPU ${layer.label} by node and rank, ${telemetry.gpuCount} GPUs${running ? "" : ", run paused"}${straggler ? `; rank ${straggler.rank} lagging` : ""}${hotSpot ? `; rank ${hotSpot.rank} hot` : ""}`}
          data-running={running || undefined}
        >
          {telemetry.nodes.map((node) => (
            <NodeRow key={node.index} node={node} metric={metric} />
          ))}
        </div>

        <div className={styles.scale} aria-hidden="true">
          <span>{metric === "hbm" ? "0" : metric === "temp" ? "30" : "0"}</span>
          {[1, 2, 3, 4, 5].map((step) => (
            <i key={step} style={{ background: `var(--scale-${step})` }} />
          ))}
          <span>
            {metric === "hbm" ? "100" : metric === "temp" ? "86" : "100"}
            {metric === "hbm" ? "%" : layer.unit}
          </span>
          <i className={styles.ringLag} />
          <span>lag</span>
          <i className={styles.ringHot} />
          <span>≥{HOT_TEMP_C}°C</span>
        </div>

        {interconnect.interNode ? (
          <div
            className={styles.fabric}
            role="meter"
            aria-label={`${interconnect.interNode} gradient traffic per node`}
            aria-valuemin={0}
            aria-valuemax={interconnect.linkGbps}
            aria-valuenow={Math.round(interconnect.trafficGbps)}
          >
            <code>{interconnect.interNode}</code>
            <span className={styles.fabricBar} aria-hidden="true">
              <i style={{ width: `${Math.min(100, trafficShare * 100).toFixed(1)}%` }} />
            </span>
            <b>
              {interconnect.trafficGbps >= 10
                ? interconnect.trafficGbps.toFixed(0)
                : interconnect.trafficGbps.toFixed(1)}
              <small> / {interconnect.linkGbps} Gb/s</small>
            </b>
          </div>
        ) : null}

        {straggler && stragglerIncident ? (
          <p className={styles.flag} data-kind="straggler" role="status">
            <i aria-hidden="true" />
            <code>
              r{straggler.rank} · {nodeName(straggler.node)}
            </code>
            <span>GPU lagging</span>
            <code>
              +{Math.round(stragglerIncident.magnitude * 100)}% · step{" "}
              {stragglerIncident.step.toLocaleString("en-US")}
            </code>
          </p>
        ) : null}
        {hotSpot ? (
          <p className={styles.flag} data-kind="hot">
            <i aria-hidden="true" />
            <code>
              r{hotSpot.rank} · {nodeName(hotSpot.node)}
            </code>
            <span>hot</span>
            <code>{hotSpot.tempC}°C</code>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
