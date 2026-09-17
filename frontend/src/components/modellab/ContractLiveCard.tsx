"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  alignmentLink,
  batchRewards,
  ingestionFor,
  type IngestionRow,
} from "@/lib/modellab/ingestion";
import {
  alignmentMatrix,
  availability,
  MODALITIES,
  MODALITY_NAMES,
  type CorpusFacts,
} from "@/lib/modellab/samples";

import { Card } from "./Cards";
import local from "./ContractLiveCard.module.css";
import { Icon } from "./icons";
import type { LiveCardProps } from "./live";
import styles from "./ModelLab.module.css";

const number = (value: number) => value.toLocaleString("en-US");

const STATUS_STATE: Record<IngestionRow["status"], string> = {
  Synced: "synced",
  Indexing: "indexing",
  "Awaiting source": "awaiting",
  "Not connected": "off",
};

/**
 * The stage's data contract, joined to what is live: real corpus counts against the plan,
 * each source's ingestion pipeline and how much of it the current epoch has consumed. Stage 3
 * shows its reward contract with the weighted reward of the current (simulated) batch.
 */
export function ContractLiveCard({
  stage,
  step,
  progress,
  now,
  config,
  facts,
}: LiveCardProps & { readonly facts: CorpusFacts }) {
  if (stage.rewards) {
    const rewards = batchRewards(stage, step, progress);
    const total = rewards.reduce((sum, reward) => sum + reward.value, 0);
    return (
      <Card
        title={stage.contractTitle}
        icon="contract"
        id="data-contract"
        aside={<span className={styles.asideNote}>Batch reward: simulated run</span>}
      >
        <div
          className={styles.tableWrap}
          tabIndex={0}
          role="region"
          aria-label={`${stage.contractTitle} table`}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                {stage.contractColumns.slice(0, 4).map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
                <th scope="col" title="Weight × mean batch score, from the simulated run">
                  Batch reward <span className={local.simTag}>sim</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {stage.rewards.map((row, index) => {
                const reward = rewards[index]!;
                return (
                  <tr key={row.name}>
                    <td>
                      <i
                        className={styles.dot}
                        style={{ background: row.colour }}
                        aria-hidden="true"
                      />
                      {row.name}
                    </td>
                    <td className={row.weight < 0 ? styles.negative : styles.strong}>
                      {row.weight.toFixed(2)}
                    </td>
                    <td>{row.source}</td>
                    <td className={styles.muted}>{row.notes}</td>
                    <td
                      className={`${local.reward} ${reward.value < 0 ? styles.negative : ""}`}
                      title={
                        row.weight < 0
                          ? `${(reward.score * 100).toFixed(1)}% of batch answers penalised`
                          : `Mean batch score ${reward.score.toFixed(2)}`
                      }
                    >
                      {reward.value >= 0 ? "+" : "−"}
                      {Math.abs(reward.value).toFixed(3)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4} className={local.totalLabel}>
                  Batch total at step {number(Math.floor(step))}
                </th>
                <td className={`${local.reward} ${styles.strong}`}>
                  {total >= 0 ? "+" : "−"}
                  {Math.abs(total).toFixed(3)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    );
  }

  const available = availability(stage.id, facts);
  const ingestion = ingestionFor(stage, facts, step, config.globalBatch, now);
  const firstRow = ingestion.values().next().value as IngestionRow | undefined;

  return (
    <Card
      title={stage.contractTitle}
      icon="contract"
      id="data-contract"
      aside={<span className={styles.asideNote}>Available now / contract</span>}
    >
      <div
        className={styles.contractBody}
        data-matrix={stage.id === "pretraining" || undefined}
      >
        <div>
          <div
            className={styles.tableWrap}
            tabIndex={0}
            role="region"
            aria-label={`${stage.contractTitle} table`}
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  {stage.contractColumns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                  <th scope="col">Pipeline</th>
                </tr>
              </thead>
              <tbody>
                {stage.contract.map((row) => {
                  const have = available.get(row.id);
                  const share = have ? Math.min(1, have.count / row.target) : 0;
                  const pipe = ingestion.get(row.id);
                  const consumedShare =
                    pipe && pipe.available > 0 ? pipe.consumed / pipe.available : 0;
                  return (
                    <tr key={row.id}>
                      <td>
                        <i
                          className={styles.dot}
                          style={{ background: row.colour }}
                          aria-hidden="true"
                        />
                        {row.name}
                      </td>
                      <td className={styles.muted}>{row.format}</td>
                      <td title={have?.basis}>
                        <span className={styles.coverage}>
                          <strong>{have ? number(have.count) : "—"}</strong>
                          <span> / {row.targetLabel}</span>
                        </span>
                        <span className={styles.coverageBar} aria-hidden="true">
                          <i
                            style={{
                              width: `${Math.max(share * 100, have?.count ? 1.5 : 0)}%`,
                            }}
                          />
                        </span>
                      </td>
                      <td>{row.volume}</td>
                      <td className={styles.muted}>{row.notes}</td>
                      <td className={local.pipeline}>
                        {pipe ? (
                          <>
                            <span
                              className={local.chip}
                              data-state={STATUS_STATE[pipe.status]}
                              data-stale={pipe.freshness === "stale" || undefined}
                            >
                              <i aria-hidden="true" />
                              {pipe.status}
                            </span>
                            <small
                              className={local.sync}
                              title={
                                pipe.lastSyncAt === null
                                  ? undefined
                                  : `Last sync ${new Date(pipe.lastSyncAt).toLocaleString("en-GB")}`
                              }
                            >
                              {pipe.syncLabel.replace(/^(Synced|Indexing) · /, "")}
                              {pipe.freshness === "stale" ? " · stale" : ""}
                            </small>
                            {pipe.available > 0 && (
                              <span className={local.epoch}>
                                <span
                                  className={local.epochBar}
                                  role="img"
                                  aria-label={`${number(pipe.consumed)} of ${number(pipe.available)} consumed in epoch ${pipe.epoch}`}
                                >
                                  <i
                                    style={{
                                      width: `${(consumedShare * 100).toFixed(1)}%`,
                                    }}
                                  />
                                </span>
                                <small aria-hidden="true">
                                  {number(pipe.consumed)}/{number(pipe.available)} · ep{" "}
                                  {pipe.epoch}
                                </small>
                              </span>
                            )}
                          </>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={local.footnote}>
            Counts are derived from the loaded corpus.{" "}
            {facts.source === "demo"
              ? "Offline: sources are the bundled fixture, so nothing syncs."
              : "Sync times follow each source's schedule and are simulated."}{" "}
            Epoch consumption follows the simulated run
            {firstRow
              ? ` (epoch ${firstRow.epoch}, ${Math.floor(firstRow.epochShare * 100)}%)`
              : ""}
            .
          </p>
        </div>
        {stage.id === "pretraining" && <AlignmentHeatmap facts={facts} />}
      </div>
    </Card>
  );
}

function AlignmentHeatmap({ facts }: { readonly facts: CorpusFacts }) {
  const matrix = alignmentMatrix(facts);
  const [open, setOpen] = useState<{ readonly r: number; readonly c: number }>();
  const host = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const max = Math.max(
    1,
    ...matrix.flatMap((row) => row.map((value) => (value === null ? 0 : value))),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(undefined);
        opener.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (host.current && !host.current.contains(event.target as Node)) setOpen(undefined);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const detail = open ? alignmentLink(open.r, open.c) : undefined;
  const openValue = open ? (matrix[open.r]?.[open.c] ?? 0) : 0;

  return (
    <div className={`${styles.matrix} ${local.heatmap}`} ref={host}>
      <h3>
        Modality alignment matrix
        <span title="Shade shows how many links exist between two modalities on this sheet (log scale). Select a cell for the count and what it counts.">
          <Icon name="info" size={13} />
        </span>
      </h3>
      <table className={local.grid}>
        <thead>
          <tr>
            <td />
            {MODALITIES.map((name, c) => (
              <th key={name} scope="col" title={MODALITY_NAMES[c]}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, r) => (
            <tr key={MODALITY_NAMES[r]}>
              <th scope="row">{MODALITY_NAMES[r]}</th>
              {row.map((value, c) => {
                if (value === null) {
                  return (
                    <td key={MODALITIES[c]}>
                      <span className={local.diagonal} aria-label="Same modality">
                        —
                      </span>
                    </td>
                  );
                }
                const intensity = value > 0 ? Math.log1p(value) / Math.log1p(max) : 0;
                const selected = open?.r === r && open?.c === c;
                return (
                  <td key={MODALITIES[c]}>
                    <button
                      type="button"
                      className={local.cell}
                      data-zero={value === 0 || undefined}
                      style={{
                        background:
                          value > 0
                            ? `rgba(37, 99, 235, ${(0.12 + 0.8 * intensity).toFixed(3)})`
                            : undefined,
                      }}
                      aria-expanded={selected}
                      aria-controls={selected ? popoverId : undefined}
                      aria-label={`${MODALITY_NAMES[r]} and ${MODALITY_NAMES[c]}: ${
                        value > 0 ? `${number(value)} links` : "no direct alignment"
                      }`}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setOpen(selected ? undefined : { r, c });
                      }}
                    >
                      <span className={local.count} aria-hidden="true">
                        {value > 0 ? number(value) : "0"}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={local.legend} aria-hidden="true">
        <span>Fewer</span>
        <span className={local.scale} />
        <span>More links (log)</span>
        <span className={local.legendZero}>
          <i /> None
        </span>
      </div>
      {open && detail && (
        <div
          id={popoverId}
          className={local.popover}
          role="dialog"
          aria-label={`${MODALITY_NAMES[open.r]} ↔ ${MODALITY_NAMES[open.c]} alignment`}
        >
          <div className={local.popoverHead}>
            <strong>
              {MODALITY_NAMES[open.r]} ↔ {MODALITY_NAMES[open.c]}
            </strong>
            <button
              type="button"
              className={local.close}
              aria-label="Close alignment detail"
              onClick={() => {
                setOpen(undefined);
                opener.current?.focus();
              }}
            >
              <Icon name="cross" size={14} />
            </button>
          </div>
          <p className={local.popoverCount}>
            {openValue > 0 ? `${number(openValue)} links` : "No direct alignment"}
          </p>
          <p>{detail.what}</p>
          <p className={local.basis}>Count basis: {detail.basis}</p>
        </div>
      )}
    </div>
  );
}
