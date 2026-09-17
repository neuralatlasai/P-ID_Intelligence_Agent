"use client";

import { useId, type CSSProperties } from "react";

import {
  formatRate,
  gpuTelemetry,
  type GpuSample,
  type NodeTelemetry,
} from "@/lib/modellab/hardware";

import { Card } from "./Cards";
import styles from "./HardwareCard.module.css";
import type { LiveCardProps } from "./live";

export type HardwareCardProps = LiveCardProps;

/** Sequential utilisation scale; the legend and the text alternatives carry the same bands. */
const BANDS = [
  { max: 25, colour: "#e2e8f0", label: "<25" },
  { max: 50, colour: "#bfdbfe", label: "25–50" },
  { max: 75, colour: "#60a5fa", label: "50–75" },
  { max: 90, colour: "#2563eb", label: "75–90" },
  { max: Infinity, colour: "#1e3a8a", label: "≥90 %" },
] as const;

const bandColour = (util: number) =>
  (BANDS.find((band) => util < band.max) ?? BANDS[4]).colour;

const gpuName = (gpu: GpuSample) => `GPU ${gpu.gpu}`;
const nodeName = (index: number) => `node-${String(index + 1).padStart(2, "0")}`;

function NodeRow({ node }: { readonly node: NodeTelemetry }) {
  const tipId = useId();
  const straggler = node.gpus.find((gpu) => gpu.straggler);
  const hot = node.gpus.find((gpu) => gpu.hot);
  const flags = [
    straggler ? `${gpuName(straggler)} lagging` : null,
    hot ? `${gpuName(hot)} hot` : null,
  ].filter(Boolean);
  return (
    <li
      className={styles.node}
      // Focusable so keyboard users reach the per-GPU breakdown the tooltip shows on hover.
      tabIndex={0}
      aria-describedby={tipId}
      data-flagged={flags.length > 0 || undefined}
    >
      <span className={styles.nodeName}>{node.name}</span>
      <span
        className={styles.cells}
        style={{ "--gpus": node.gpus.length } as CSSProperties}
        aria-hidden="true"
      >
        {node.gpus.map((gpu) => (
          <i
            key={gpu.gpu}
            className={styles.cell}
            style={{ background: bandColour(gpu.utilPct) }}
            data-hot={gpu.hot || undefined}
          />
        ))}
      </span>
      <span className={styles.nodeSummary}>
        <span className="srOnly">{node.name}: average utilisation </span>
        {Math.round(node.avgUtilPct)}%<span className="srOnly">, hottest GPU</span>
        <span aria-hidden="true"> · </span>
        {node.maxTempC}°C<span className="srOnly">, board power</span>
        <span aria-hidden="true"> · </span>
        {(node.powerW / 1000).toFixed(1)} kW
        {flags.length > 0 ? <span className="srOnly">; {flags.join(", ")}</span> : null}
      </span>
      <span role="tooltip" id={tipId} className={styles.tip}>
        <span className={styles.tipHead}>
          {node.name} · {node.gpus.length} GPUs
        </span>
        <span className={styles.tipGrid}>
          <span className={styles.tipCol}>GPU</span>
          <span className={styles.tipCol}>Util</span>
          <span className={styles.tipCol}>Memory</span>
          <span className={styles.tipCol}>Temp</span>
          <span className={styles.tipCol}>Power</span>
          {node.gpus.map((gpu) => (
            <span
              key={gpu.gpu}
              className={styles.tipRow}
              data-hot={gpu.hot || undefined}
              data-straggler={gpu.straggler || undefined}
            >
              <span>{gpu.gpu}</span>
              <span>{gpu.utilPct.toFixed(0)}%</span>
              <span>
                {gpu.memUsedGb.toFixed(1)}/{gpu.memTotalGb} GB
              </span>
              <span>{gpu.tempC}°C</span>
              <span>{gpu.powerW} W</span>
            </span>
          ))}
        </span>
      </span>
    </li>
  );
}

export function HardwareCard({ stage, now, running, config, profile }: HardwareCardProps) {
  const telemetry = gpuTelemetry(profile, config, stage.run.stepsPerSecond, running, now);
  const { interconnect } = telemetry;
  const fabric = interconnect.interNode
    ? `${interconnect.intraNode} + ${interconnect.interNode}`
    : `${interconnect.intraNode} (single node)`;
  const traffic =
    interconnect.state === "idle"
      ? "idle"
      : interconnect.interNode
        ? `${interconnect.trafficGbps >= 10 ? interconnect.trafficGbps.toFixed(0) : interconnect.trafficGbps.toFixed(1)} Gbit/s all-reduce`
        : "intra-node all-reduce";

  return (
    <Card
      title="Cluster telemetry"
      icon="monitoring"
      aside={
        <span
          className={styles.simChip}
          title="No GPU cluster is connected; telemetry is simulated from the run configuration"
        >
          <i aria-hidden="true" />
          Simulated
        </span>
      }
    >
      <div className={styles.body}>
        <dl className={styles.stats}>
          <div>
            <dt>Samples/s</dt>
            <dd>{running ? formatRate(telemetry.samplesPerSecond) : "0"}</dd>
          </div>
          <div>
            <dt>Tokens/s</dt>
            <dd>{running ? formatRate(telemetry.tokensPerSecond) : "0"}</dd>
          </div>
          <div>
            <dt>Avg GPU util</dt>
            <dd>{telemetry.avgUtilPct.toFixed(0)}%</dd>
          </div>
          <div>
            <dt>GPU power</dt>
            <dd>{telemetry.powerKw.toFixed(1)} kW</dd>
          </div>
          <div className={styles.wide}>
            <dt>Interconnect</dt>
            <dd>
              <span className={styles.link} data-state={interconnect.state}>
                <i aria-hidden="true" />
                {traffic}
              </span>
              <span className={styles.fabric}>{fabric}</span>
            </dd>
          </div>
        </dl>

        <div className={styles.mapHead}>
          <span>GPU utilisation</span>
          <span className={styles.mapMeta}>
            {telemetry.nodes.length} × {config.gpusPerNode} · {profile.accelerator.name}
          </span>
        </div>
        <ul
          className={styles.nodes}
          aria-label={`GPU utilisation by node, ${telemetry.gpuCount} GPUs${running ? "" : ", run paused"}`}
        >
          {telemetry.nodes.map((node) => (
            <NodeRow key={node.index} node={node} />
          ))}
        </ul>

        <ul className={styles.legend} aria-label="Legend">
          {BANDS.map((band) => (
            <li key={band.label}>
              <i style={{ background: band.colour }} aria-hidden="true" />
              {band.label}
            </li>
          ))}
          <li>
            <i className={styles.legendHot} aria-hidden="true" />
            Hot ≥79°C
          </li>
        </ul>

        {running && (telemetry.straggler || telemetry.hotSpot) ? (
          <ul className={styles.notes}>
            {telemetry.straggler ? (
              <li data-kind="straggler">
                {nodeName(telemetry.straggler.node)} · {gpuName(telemetry.straggler)}{" "}
                lagging at {telemetry.straggler.utilPct.toFixed(0)}% — synchronous steps
                wait on the slowest rank
              </li>
            ) : null}
            {telemetry.hotSpot ? (
              <li data-kind="hot">
                {nodeName(telemetry.hotSpot.node)} · {gpuName(telemetry.hotSpot)} at{" "}
                {telemetry.hotSpot.tempC}°C — above the fleet band, check airflow
              </li>
            ) : null}
          </ul>
        ) : null}

        <p className={styles.footnote}>
          {running ? "Simulated telemetry" : "Run paused · GPUs idle, memory held"} · no
          cluster connected · 5 s scrape
        </p>
      </div>
    </Card>
  );
}
