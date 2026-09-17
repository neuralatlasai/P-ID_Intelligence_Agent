"use client";

import { useEffect, useMemo, useState } from "react";

import type { PlantRegister } from "@/lib/canvas/engineering";
import { SCAN_MS, telemetryFor, type Telemetry } from "@/lib/canvas/telemetry";

import styles from "./ConnectedResponse.module.css";

/**
 * How the selected component and the equipment connected to it are behaving right now.
 *
 * Each row is that asset's own signal in its own engineering unit, with its normal band and
 * ISA-18.2 alarm state, so the view answers the question the connection playback raises:
 * "what is on the path from here, and is any of it outside normal?" Rows the traversal has
 * reached are marked. Signals are simulated per tag and labelled so; no process physics is
 * inferred between assets, because the undirected drawing graph does not establish flow.
 */
export function ConnectedResponse({
  selected,
  joined,
  reached,
  register,
  labelOf,
  onSelect,
}: {
  readonly selected: string;
  readonly joined: readonly { readonly id: string; readonly hops: number }[];
  /** Graph depth at which each node was reached by the traversal so far. */
  readonly reached: ReadonlyMap<string, number>;
  readonly register: PlantRegister;
  readonly labelOf: (id: string) => string;
  readonly onSelect: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, SCAN_MS);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const ids = [{ id: selected, hops: 0 }, ...joined.slice(0, 11)];
    return ids.flatMap(({ id, hops }) => {
      const asset = register.assets.get(id);
      if (!asset) return [];
      // A valve or vessel without its own transmitter shows its loop partner's measurement.
      const measuring = asset.telemetry
        ? asset
        : asset.loop
          ? [...register.assets.values()].find(
              (other) => other.loop === asset.loop && other.telemetry,
            )
          : undefined;
      const data = measuring ? telemetryFor(measuring, register, "1H", now) : undefined;
      return [{ id, hops, asset, measuring, data }];
    });
  }, [selected, joined, register, now]);

  const outside = rows.filter((row) => row.data?.active).length;

  return (
    <section className={styles.response} aria-label="Connected equipment response">
      <header>
        <h3>Connected equipment · live response</h3>
        <span className={styles.meta}>
          <i aria-hidden="true" /> Simulated signals · {SCAN_MS / 1000} s scan · updated{" "}
          {new Date(now).toLocaleTimeString("en-GB")}
        </span>
      </header>
      <p className={styles.summary}>
        {rows.length} assets on the path from {labelOf(selected)} ·{" "}
        {outside ? (
          <strong className={styles.alarm}>{outside} in alarm</strong>
        ) : (
          <strong className={styles.ok}>all within limits</strong>
        )}
      </p>
      <div
        className={styles.tableWrap}
        tabIndex={0}
        role="region"
        aria-label="Asset signals"
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Tag</th>
              <th scope="col">Hops</th>
              <th scope="col">Signal</th>
              <th scope="col">Value</th>
              <th scope="col">Normal</th>
              <th scope="col">Last hour</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, hops, asset, measuring, data }) => {
              const depth = reached.get(id);
              return (
                <tr
                  key={id}
                  data-selected={id === selected || undefined}
                  data-reached={depth !== undefined || undefined}
                >
                  <td>
                    <button onClick={() => onSelect(id)} title={asset.name}>
                      {labelOf(id)}
                    </button>
                    <small>{asset.name}</small>
                  </td>
                  <td>{hops === 0 ? "—" : hops}</td>
                  <td>
                    {data ? data.measurement : "No measurement"}
                    {measuring && measuring.nodeId !== id && (
                      <small>via {measuring.tag}</small>
                    )}
                  </td>
                  <td className={styles.value}>
                    {data
                      ? `${data.current.pv.toFixed(Math.abs(data.current.pv) >= 100 ? 1 : 2)} ${data.unit}`
                      : "—"}
                  </td>
                  <td>{data ? `${data.normal[0]}–${data.normal[1]}` : "—"}</td>
                  <td>{data ? <Spark data={data} /> : null}</td>
                  <td>
                    <span
                      className={styles.state}
                      data-state={
                        data?.active ? data.active.priority : data ? "ok" : "none"
                      }
                    >
                      {data?.active
                        ? `${data.active.level} alarm`
                        : data
                          ? data.quality === "Good"
                            ? "Normal"
                            : "Check quality"
                          : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Spark({ data }: { readonly data: Telemetry }) {
  const values = data.series.map((sample) => sample.pv);
  const lo = Math.min(...values, data.normal[0]);
  const hi = Math.max(...values, data.normal[1]);
  const w = 120;
  const h = 28;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * w;
  const y = (v: number) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label={`${data.tag} last hour, ${values.length} scans`}
    >
      <rect
        x={0}
        y={y(data.normal[1])}
        width={w}
        height={Math.max(1, y(data.normal[0]) - y(data.normal[1]))}
        className={styles.band}
      />
      <path
        d={values
          .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
          .join("")}
        className={styles.line}
      />
    </svg>
  );
}
