"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";

import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  readonly productName: string;
  readonly onUseExample: (text: string) => void;
}

/** Stroke icon on a 24-unit grid, drawn in currentColor. */
function Glyph({ d, size = 22 }: { readonly d: string; readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

const ICON = {
  component:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-1 .5-2.2-1.8-1.3-1.7 1.5L13 8l-1-2-1 2-2 .5-1.7-1.5-1.8 1.3L6 11l-2 1 2 1-.5 2.2 1.8 1.3 1.7-1.5 2 .5 1 2 1-2 2-.5 1.7 1.5 1.8-1.3L18 13z",
  detections: "M4 5h16v14H4zM8 9h3v3H8zM13 13h3v3h-3zM13 9h3M8 15h3",
  connectivity:
    "M6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.6 14.8l8.8-5.6",
  revisions: "M7 3h7l5 5v13H7zM14 3v5h5M3 7v14h11M10 13h6M10 17h4",
  agreement:
    "M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6.5 7 17.5M13 6.5l4 11",
  review: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9h.01",
  database:
    "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  chart: "M5 20V10m5 10V4m5 16v-7m5 7v-4M3 20h18",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  image: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01",
  share:
    "M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 11l8-4M8 13l8 4",
  map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  plain: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  shield: "M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6z",
} as const;

/**
 * Example questions.
 *
 * Each exercises a different capability of the backend — a single component, detections,
 * connectivity, cross-revision comparison, source agreement, a full review — so the first
 * thing a new user tries shows what the system is for. They are phrased generically rather
 * than naming a tag this deployment may not hold, which would make the very first answer an
 * honest "no evidence" that reads as a broken product.
 */
const EXAMPLES: readonly { label: string; icon: keyof typeof ICON; text: string }[] = [
  {
    label: "Component",
    icon: "component",
    text: "Explain one component in plain language: what it is, what it does, what it connects to, and how you know.",
  },
  {
    label: "Detections",
    icon: "detections",
    text: "List every detected component on one drawing by class, with exact counts and identifiers.",
  },
  {
    label: "Connectivity",
    icon: "connectivity",
    text: "What is connected to a given valve tag, and in which direction?",
  },
  {
    label: "Revisions",
    icon: "revisions",
    text: "Compare two revisions of the same drawing and describe what changed.",
  },
  {
    label: "Agreement",
    icon: "agreement",
    text: "Do the topology file and the drawing agree about a connection?",
  },
  {
    label: "Full review",
    icon: "review",
    text: "Give me an end-to-end review of one drawing: components, topology, anomalies, evidence, and pipeline coverage.",
  },
];

/**
 * How an answer is put together. Each line is a constraint the product holds itself to, so
 * an engineer deciding whether to trust an answer does not discover them one at a time.
 */
const GUARANTEES: readonly { rule: string; detail: string; icon: keyof typeof ICON }[] = [
  {
    rule: "Plain language first",
    detail: "technical terms are defined without removing engineering detail",
    icon: "plain",
  },
  {
    rule: "Components are identified",
    detail: "exact tag or source node, purpose, connections and limits",
    icon: "component",
  },
  {
    rule: "Every claim is labelled",
    detail: "observed, corroborated, inferred, conflicting or unknown",
    icon: "tag",
  },
  {
    rule: "Every source is named",
    detail: "with whether the agent opened it or only cited it",
    icon: "database",
  },
  {
    rule: "No numeric confidence",
    detail: "support is categorical until a score is calibrated",
    icon: "shield",
  },
];

interface Catalog {
  readonly artifacts: number | null;
  readonly drawings: number | null;
  readonly samples: readonly string[];
}

/**
 * Read what is actually in this deployment's corpus.
 *
 * Counts come from the backend through the gateway; nothing here is a constant. A
 * deployment pointed at three drawings should say three, and a failed read shows nothing
 * rather than a plausible number.
 */
function useCatalog(): Catalog {
  const [catalog, setCatalog] = useState<Catalog>({
    artifacts: null,
    drawings: null,
    samples: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const [health, drawings] = await Promise.all([
          fetch("/api/health", { signal: controller.signal, cache: "no-store" }),
          fetch("/api/canvas/drawings?offset=0", {
            signal: controller.signal,
            cache: "no-store",
          }),
        ]);
        const healthBody: unknown = health.ok ? await health.json() : null;
        const catalogBody: unknown = drawings.ok ? await drawings.json() : null;
        if (controller.signal.aborted) return;
        setCatalog({
          artifacts: readCount(healthBody, "corpusFiles"),
          drawings: readCount(catalogBody, "total"),
          samples: readSamples(catalogBody),
        });
      } catch {
        // A landing page is not worth an error banner. Without counts it simply shows none.
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  return catalog;
}

function readCount(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readSamples(body: unknown): readonly string[] {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 3)
    .map((item: unknown) =>
      item &&
      typeof item === "object" &&
      typeof (item as { source?: unknown }).source === "string"
        ? (item as { source: string }).source
        : "",
    )
    .filter((source): source is string => source.length > 0 && source.length <= 1024);
}

function Panel({
  icon,
  title,
  subtitle,
  id,
  children,
}: {
  readonly icon: keyof typeof ICON;
  readonly title: string;
  readonly subtitle: string;
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <header className={styles.panelHeader}>
        <span className={styles.badge}>
          <Glyph d={ICON[icon]} size={20} />
        </span>
        <div>
          <h3 id={id}>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/**
 * The empty session view.
 *
 * It answers the three questions someone opening a blank session has: what can I ask, what
 * is in scope, and how will the answer be presented. Examples populate the composer without
 * submitting, so the user stays in control of what is asked. The side ornaments are
 * decorative line art, hidden from assistive technology and from narrow screens.
 */
export function EmptyState({ productName, onUseExample }: EmptyStateProps) {
  const catalog = useCatalog();

  return (
    <div className={styles.stage}>
      <div className={styles.rail} aria-hidden="true">
        <i />
        <span>From drawings to answers</span>
      </div>
      <svg
        className={styles.lineArt}
        viewBox="0 0 160 560"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M150 40H60v60h-30v80h40M30 180v140h50M90 60v-30h40v30M60 100h70v40" />
        <path d="M70 220a50 50 0 0 1 100 0v240a50 50 0 0 1-100 0z" />
        <path d="M20 320h50M20 420h50M110 470v60h-60v-40" />
        <circle cx="30" cy="100" r="6" />
        <circle cx="60" cy="380" r="6" />
        <rect x="36" y="210" width="20" height="18" rx="3" />
        <rect x="36" y="300" width="20" height="18" rx="3" />
      </svg>
      <span className={styles.tagChip} aria-hidden="true">
        T-100
      </span>
      <p className={styles.motto} aria-hidden="true">
        Safer plants through clearer information
      </p>

      <div className={styles.wrapper}>
        <header className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>{productName}</p>
            <h2 className={styles.title}>What would you like to analyse?</h2>
            <p className={styles.subtitle}>
              Ask a question about your P&ID drawings, topology, or run a structured review.
            </p>
          </div>
          <div className={styles.flow}>
            <ol aria-label="How an answer is built">
              <li>Drawings</li>
              <li>Topology</li>
              <li>Insights</li>
            </ol>
            <p>Engineering context. Verifiable answers.</p>
          </div>
        </header>

        <section aria-label="Start with a question" className={styles.examples}>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              className={styles.example}
              onClick={() => onUseExample(example.text)}
            >
              <span className={styles.exampleIcon}>
                <Glyph d={ICON[example.icon]} size={26} />
              </span>
              <span className={styles.exampleLabel}>{example.label}</span>
              <span className={styles.exampleText}>{example.text}</span>
              <ChevronRightIcon size={16} />
            </button>
          ))}
        </section>
        <p className={styles.hint}>
          <Glyph d={ICON.info} size={16} />
          Choosing one fills the box below. Nothing is sent until you send it.
        </p>

        <div className={styles.columns}>
          <Panel
            id="empty-scope"
            icon="database"
            title="In scope"
            subtitle="Data available for this session"
          >
            <dl className={styles.scope}>
              <div>
                <dt>
                  <Glyph d={ICON.file} size={18} />
                  Corpus artifacts
                </dt>
                <dd>
                  {catalog.artifacts === null ? "—" : catalog.artifacts.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>
                  <Glyph d={ICON.image} size={18} />
                  Drawing + topology pairs
                </dt>
                <dd>
                  {catalog.drawings === null ? "—" : catalog.drawings.toLocaleString()}
                </dd>
              </div>
            </dl>
            {catalog.samples.length > 0 && (
              <div className={styles.samples}>
                <h4>Example datasets</h4>
                <ul>
                  {catalog.samples.map((source) => (
                    <li key={source}>
                      <Glyph d={ICON.share} size={16} />
                      {source}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Link className={styles.canvasLink} href="/canvas">
              <Glyph d={ICON.map} size={24} />
              Browse drawings on the canvas
              <ChevronRightIcon size={16} />
            </Link>
          </Panel>

          <Panel
            id="empty-rules"
            icon="chart"
            title="How answers are presented"
            subtitle="Consistent, verifiable, engineering-focused"
          >
            <ul className={styles.guarantees}>
              {GUARANTEES.map((item) => (
                <li key={item.rule}>
                  <span className={styles.guaranteeIcon}>
                    <Glyph d={ICON[item.icon]} size={20} />
                  </span>
                  <span>
                    <strong>{item.rule}</strong>
                    <small>{item.detail}</small>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
