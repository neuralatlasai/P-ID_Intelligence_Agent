"use client";

import {
  deploymentMeasurements,
  LOCAL_ANSWER_TOKENS,
  LOCAL_P95_TARGET_S,
  type DeploymentStatus,
} from "@/lib/modellab/ingestion";

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
 * quantisation-aware pass measured at the last published evaluation — the same evaluation
 * the metrics table and the checkpoint table report.
 */
export function DeploymentLiveCard({ stage, step, now }: LiveCardProps) {
  const measured = deploymentMeasurements(stage, step, now);
  const measuredStep = measured.evalStep;

  return (
    <Card
      title="Deployment targets"
      icon="target"
      id="deployment"
      aside={
        <span className={styles.asideNote}>
          {measuredStep === 0
            ? "Baseline eval (step 0)"
            : `Measured at eval step ${measuredStep.toLocaleString("en-US")}`}
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
              <th
                scope="col"
                title={`Seconds per request (4K-token prompt, ${LOCAL_ANSWER_TOKENS}-token answer), median / 95th percentile`}
              >
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
                        ? target.p95 < LOCAL_P95_TARGET_S
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
        Measurements come from the simulated quantisation-aware pass of each evaluation
        (last published: step {measuredStep.toLocaleString("en-US")}). The local profile
        reads the latency, throughput and memory rows of the metrics table; no inference
        hardware is attached.
      </p>
    </Card>
  );
}
