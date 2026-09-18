"use client";

import type { ReactNode } from "react";

import { objectiveShares } from "@/lib/modellab/ingestion";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import styles from "./ModelLab.module.css";
import local from "./RecipeLiveCard.module.css";
import { seriesColour } from "@/lib/series";

const number = (value: number) => value.toLocaleString("en-US");

function formatB(billions: number): string {
  return `${billions.toFixed(billions < 10 ? 2 : 1)}B`;
}

function formatLoss(loss: number): string {
  if (loss >= 1) return loss.toFixed(2);
  if (loss >= 0.1) return loss.toFixed(3);
  return loss.toFixed(4);
}

/**
 * The stage recipe with the parts that depend on the run made live: model rows follow the
 * applied configuration, and in stages 1 and 2 the objectives show their weight, current
 * (simulated) loss and share of the weighted total.
 */
export function RecipeLiveCard({ stage, step, config, profile }: LiveCardProps) {
  const objectives = objectiveShares(stage, step);
  const encodersB = (profile.spatial.paramsM + profile.graph.paramsM) / 1000;
  const totalB = profile.backbone.params + encodersB;
  const precision = config.precision === "fp8" ? "FP8" : "BF16";

  const valueFor = (key: string, value: string | readonly string[]): ReactNode => {
    switch (key) {
      case "Backbone VLM":
      case "Policy model":
      case "Student model":
        return profile.backbone.name;
      case "3D encoder":
      case "3D bridge":
        return profile.spatial.name;
      case "Graph encoder":
        return profile.graph.name;
      case "Context window":
        return `${profile.backbone.contextK}K`;
      case "Precision":
        return precision;
      case "Trainable modules":
        if (config.trainable === "full" && stage.id !== "distillation") {
          return "Full backbone, projector, encoders and heads";
        }
        break;
    }
    return typeof value === "string"
      ? value
      : value.map((line) => <span key={line}>{line}</span>);
  };

  const trainable = `${formatB(profile.trainableB)} of ${formatB(totalB)} (${
    config.trainable === "full"
      ? stage.id === "distillation"
        ? "full student"
        : "full fine-tune"
      : "LoRA + projector + encoders"
  })`;

  const rows: { key: string; value: ReactNode; objectives?: boolean }[] = [];
  for (const row of stage.recipe) {
    if (row.key === "Objectives" && objectives.length) {
      rows.push({ key: "Trainable parameters", value: trainable });
      rows.push({
        key: "Tokens per sample (avg)",
        value: `${number(Math.round(profile.tokensPerSample))} tokens`,
      });
      rows.push({ key: row.key, value: null, objectives: true });
      continue;
    }
    rows.push({ key: row.key, value: valueFor(row.key, row.value) });
    if (row.key === "Trainable modules" && !objectives.length) {
      rows.push({ key: "Trainable parameters", value: trainable });
      rows.push({
        key: "Tokens per sample (avg)",
        value: `${number(Math.round(profile.tokensPerSample))} tokens`,
      });
    }
  }

  return (
    <Card
      title={stage.recipeTitle}
      icon="recipe"
      aside={
        objectives.length ? (
          <span className={styles.asideNote}>Losses from simulated run</span>
        ) : undefined
      }
    >
      <dl className={styles.kv}>
        {rows.map((row) =>
          row.objectives ? (
            <div key={row.key} className={local.objectivesRow}>
              <dt>
                {row.key}
                <small className={local.objectivesHint}>weight · loss · share</small>
              </dt>
              <dd>
                <ul className={local.objectives}>
                  {objectives.map((objective, index) => (
                    <li key={objective.key}>
                      <div className={local.objectiveLine}>
                        <i style={{ background: seriesColour(index) }} aria-hidden="true" />
                        <strong title={objective.label}>{objective.label}</strong>
                        <small>
                          <span className="srOnly">weight </span>×
                          {objective.weight.toFixed(2)}
                        </small>
                        <small className={local.loss}>
                          <span className="srOnly">, loss </span>
                          {formatLoss(objective.loss)}
                          {objective.derived ? "*" : ""}
                        </small>
                        <small className={local.share}>
                          <span className="srOnly">, share of weighted loss </span>
                          {Math.round(objective.share * 100)}%
                        </small>
                      </div>
                      <div className={local.track} aria-hidden="true">
                        <div
                          className={local.fill}
                          style={{
                            width: `${(objective.share * 100).toFixed(1)}%`,
                            background: seriesColour(index),
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
                {objectives.some((objective) => objective.derived) && (
                  <small className={local.footnote}>
                    * Logged separately; not plotted in the loss chart.
                  </small>
                )}
              </dd>
            </div>
          ) : (
            <div key={row.key}>
              <dt>{row.key}</dt>
              <dd>{row.value}</dd>
            </div>
          ),
        )}
      </dl>
    </Card>
  );
}
