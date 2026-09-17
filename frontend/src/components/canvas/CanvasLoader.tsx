"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { drawing as fixture, parseDrawing, type CanvasDrawing } from "@/lib/canvas/model";
import { IndustrialWorkspace } from "./IndustrialWorkspace";
import styles from "./IndustrialWorkspace.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; drawing: CanvasDrawing; source: "backend" | "demo" };
export interface CatalogEntry {
  readonly source: string;
  readonly imagePath: string;
}

/** Abort old reads on source changes; a failed backend never silently becomes a demo. */
export function CanvasLoader({
  sessionId,
  initialNode,
  initialView,
}: {
  readonly sessionId: string;
  readonly initialNode?: string | undefined;
  readonly initialView?: string | undefined;
}) {
  const [path, setPath] = useState("PID2Graph OPEN100/0.graphml");
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/canvas/drawings?offset=${offset}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("The drawing catalog is unavailable.");
        const result = await response.json();
        if (
          !Array.isArray(result.items) ||
          result.items.length > 100 ||
          !Number.isSafeInteger(result.total) ||
          result.total < 0 ||
          !result.items.every(
            (item: CatalogEntry) =>
              item && typeof item.source === "string" && typeof item.imagePath === "string",
          )
        )
          throw new Error("The drawing catalog returned invalid data.");
        if (controller.signal.aborted) return;
        setCatalog(result.items);
        setTotal(result.total);
        setCatalogError("");
      } catch (error) {
        if (!controller.signal.aborted)
          setCatalogError(
            error instanceof Error ? error.message : "Could not load the drawing catalog.",
          );
      }
    }
    void load();
    return () => controller.abort();
  }, [offset, version]);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/canvas/graph/${encodeURIComponent(path)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(
            `Drawing service returned HTTP ${response.status}. Check the backend connection or select another source.`,
          );
        const result = parseDrawing(await response.json());
        if (!result) throw new Error("The drawing service returned unsupported geometry.");
        if (!controller.signal.aborted)
          setState({ kind: "ready", drawing: result, source: "backend" });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            kind: "failed",
            message: error instanceof Error ? error.message : "Could not load the drawing.",
          });
      }
    }
    void load();
    return () => controller.abort();
  }, [path, version]);
  const change = useCallback((source: string) => {
    setState({ kind: "loading" });
    setPath(source);
    setVersion((value) => value + 1);
  }, []);
  const demo = () => {
    setState({
      kind: "ready",
      drawing: { ...fixture, imagePath: "PID2Graph OPEN100/0.png" },
      source: "demo",
    });
  };
  /**
   * The drawing library.
   *
   * A select holding four hundred options is a list you cannot look at. The corpus groups
   * naturally by folder, so the catalogue is shown as its folders with their sheets
   * underneath — which is how the files are actually organised, and how an engineer would
   * look for one.
   */
  const grouped = useMemo(() => {
    const folders = new Map<string, CatalogEntry[]>();
    for (const item of catalog) {
      const slash = item.source.lastIndexOf("/");
      const folder = slash === -1 ? "Corpus root" : item.source.slice(0, slash);
      const bucket = folders.get(folder);
      if (bucket) bucket.push(item);
      else folders.set(folder, [item]);
    }
    return [...folders.entries()];
  }, [catalog]);

  const catalogControl = (
    <div className={styles.catalogControl}>
      <div className={styles.catalogBar}>
        <span>
          {total
            ? `${offset + 1}–${Math.min(offset + 100, total)} of ${total} drawing pairs`
            : "No drawing pairs listed"}
        </span>
        <button
          disabled={offset === 0}
          onClick={() => setOffset((value) => Math.max(0, value - 100))}
        >
          Previous
        </button>
        <button
          disabled={offset + 100 >= total}
          onClick={() => setOffset((value) => value + 100)}
        >
          Next
        </button>
      </div>

      {grouped.map(([folder, items]) => (
        <section key={folder} className={styles.catalogFolder}>
          <h4>
            {folder}
            <span>{items.length}</span>
          </h4>
          <div>
            {items.map((item) => {
              const sheet = item.source.split("/").at(-1) ?? item.source;
              return (
                <button
                  key={item.source}
                  aria-pressed={item.source === path}
                  onClick={() => change(item.source)}
                  title={item.source}
                >
                  {sheet.replace(/\.graphml$/, "")}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {catalogError && <p role="status">{catalogError}</p>}
    </div>
  );
  if (state.kind === "ready")
    return (
      <IndustrialWorkspace
        key={`${state.source}:${state.drawing.source}`}
        sessionId={sessionId}
        drawing={state.drawing}
        sourceMode={state.source}
        catalogControl={catalogControl}
        onReconnect={() => change(path)}
        initialNode={initialNode}
        initialView={initialView}
      />
    );
  return (
    <main className={styles.connectionScreen}>
      <h1>P&ID workspace</h1>
      <p role="status">
        {state.kind === "loading"
          ? "Loading drawing and source topology from the backend…"
          : state.message}
      </p>
      {catalogControl}
      {state.kind === "failed" && (
        <div>
          <button onClick={() => change(path)}>Retry connection</button>
          <button onClick={demo}>Open offline demonstration</button>
        </div>
      )}
      <Link href="/">Open conversations</Link>
    </main>
  );
}
