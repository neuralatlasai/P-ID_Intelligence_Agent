"use client";

import { deploymentMeasurements, type DeploymentStatus } from "@/lib/modellab/ingestion";

import { Card } from "./Cards";
import local from "./DeploymentLiveCard.module.css";
import type { LiveCardProps } from "./live";
import styles from "./ModelLab.module.css";

const STATE: Record<DeploymentStatus, string> = {
  Supported: "run",
  Ready: "run",
  Pending: "pause",
};

/**
 * Stage 4 deployment targets with the latency, throughput and memory the simulated
 * quantisation-aware evaluation measured at the last completed epoch.
 */
export function DeploymentLiveCard({ stage, progress, now }: LiveCardProps) {
  const { run } = stage;
  const epochs = run.epochs ?? 50;
  const runSeconds = run.totalSteps / Math.max(1e-9, run.stepsPerSecond);
  const measured = deploymentMeasurements(progress, now, epochs, runSeconds);
  const measuredStep = Math.round(measured.measuredProgress * run.totalSteps);

  return (
    <Card
      title="Deployment targets"
      icon="target"
      id="deployment"
      aside={
        <span className={styles.asideNote}>
          {measured.epoch === 0
            ? "Baseline eval (epoch 0)"
            : `Measured at epoch ${measured.epoch}/${measured.epochs}`}
        </span>
      }
    >
      <div
        className={styles.tableWrap}
        tabIndex={0}
        role="region"
        aria-label="Deployment targets table"
      >
        <table className={`${styles.table} ${local.table}`}>
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col">Status</th>
              <th scope="col" title="Seconds per sample, median / 95th percentile">
                p50 / p95
              </th>
              <th scope="col">Tokens/s</th>
              <th scope="col">Memory</th>
            </tr>
          </thead>
          <tbody>
            {measured.targets.map((target) => (
              <tr key={target.id}>
                <th scope="row">
                  <strong className={local.name}>{target.name}</strong>
                  <small className={local.detail}>{target.detail}</small>
                </th>
                <td>
                  <span className={styles.inlineStatus} data-state={STATE[target.status]}>
                    <i aria-hidden="true" />
                    {target.status}
                  </span>
                  <small className={local.detail}>{target.gate}</small>
                </td>
                <td className={local.numeric}>
                  {target.p50.toFixed(2)} /{" "}
                  <span
                    className={
                      target.id === "local"
                        ? target.p95 < 1
                          ? styles.good
                          : styles.warn
                        : undefined
                    }
                  >
                    {target.p95.toFixed(2)} s
                  </span>
                </td>
                <td className={local.numeric}>{target.tokensPerSecond.toFixed(1)}</td>
                <td className={local.numeric}>{target.memoryGb.toFixed(1)} GB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={local.note}>
        Measurements come from the simulated quantisation-aware evaluation run at the end of
        each epoch (last: step {measuredStep.toLocaleString("en-US")}); no inference
        hardware is attached.
      </p>
    </Card>
  );
}
