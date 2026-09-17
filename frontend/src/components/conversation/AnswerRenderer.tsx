"use client";

import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AlertIcon } from "@/components/ui/icons";
import { externalLinkAttributes, safeHref } from "@/lib/security/sanitize";
import {
  splitAnswer,
  type AnswerSegment,
  type SectionKind,
} from "@/lib/responses/sections";

import styles from "./AnswerRenderer.module.css";

export interface AnswerRendererProps {
  readonly text: string;
  /** True while text is still arriving, which shows the insertion cursor. */
  readonly streaming?: boolean;
  /** True when the run ended without completing, so the text may be unfinished. */
  readonly partial?: boolean;
}

/**
 * The canonical answer surface.
 *
 * The full answer is always rendered. Recognised headings — the backend's evidence
 * vocabulary — get a coloured rule and a styled heading, and everything else renders as
 * ordinary Markdown. Because the segments concatenate back to the original text, this
 * treatment can never hide content: a heading the parser fails to recognise simply renders
 * without the extra styling.
 *
 * Raw HTML is disabled. Model output is untrusted, and `react-markdown` ignores embedded
 * HTML unless a plugin re-enables it, which nothing here does. Link and image URLs pass
 * through a scheme allowlist, so a `javascript:` href in generated Markdown becomes plain
 * text rather than a working link.
 */
export const AnswerRenderer = memo(function AnswerRenderer({
  text,
  streaming = false,
  partial = false,
}: AnswerRendererProps) {
  const segments = useMemo(() => splitAnswer(text), [text]);

  if (!text) {
    return null;
  }

  return (
    <div className={styles.answer}>
      {partial ? (
        <p className={styles.partialNotice}>
          <AlertIcon size={15} />
          <span>
            <strong>Partial response.</strong> The run did not complete, so this text is
            incomplete and is not a finished engineering answer.
          </span>
        </p>
      ) : null}

      {segments.map((segment, index) => (
        <AnswerSection
          key={`${segment.kind}-${index}`}
          segment={segment}
          showCursor={streaming && index === segments.length - 1}
        />
      ))}
    </div>
  );
});

function AnswerSection({
  segment,
  showCursor,
}: {
  readonly segment: AnswerSegment;
  readonly showCursor: boolean;
}) {
  const classified = isClassified(segment.kind);
  const classes = [
    styles.section,
    classified ? styles.classified : "",
    classified ? (styles[segment.kind] ?? "") : "",
  ]
    .filter(Boolean)
    .join(" ");

  // A heading with no body yet — common mid-stream — still renders its heading, so the
  // answer does not appear to jump backwards when the body arrives.
  return (
    <section className={classes}>
      {segment.heading ? <HeadingLine heading={segment.heading} /> : null}
      <div className="prose">
        <Markdown text={segment.body} />
        {showCursor ? <span className={styles.cursor} aria-hidden="true" /> : null}
      </div>
    </section>
  );
}

/**
 * Render a heading, splitting a trailing parenthetical qualifier into quieter text.
 *
 * `Observed (from drawings and documents)` reads better as a strong label plus a muted
 * qualifier than as one uniformly bold line.
 */
function HeadingLine({ heading }: { readonly heading: string }) {
  const cleaned = heading.replace(/^#{1,6}\s*/, "").replace(/^\*\*(.*?)\*\*:?$/, "$1");
  const match = /^(.*?)\s*(\([^)]*\))\s*:?$/.exec(cleaned);

  return (
    <h3 className={styles.heading}>
      <span>{(match?.[1] ?? cleaned).replace(/:$/, "")}</span>
      {match?.[2] ? <span className={styles.qualifier}>{match[2]}</span> : null}
    </h3>
  );
}

const CLASSIFIED: ReadonlySet<SectionKind> = new Set([
  "observed",
  "corroborated",
  "inferred",
  "conflicting",
  "unknown",
]);

function isClassified(kind: SectionKind): boolean {
  return CLASSIFIED.has(kind);
}

/**
 * Markdown components.
 *
 * Defined once at module scope rather than per render: `react-markdown` treats a new
 * components object as a reason to rebuild, and during streaming this renders on every
 * flush.
 */
const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, ...rest }) {
    const safe = safeHref(href);
    if (!safe) {
      // A rejected URL keeps its text. Dropping the text would silently remove content the
      // answer contained; rendering an unusable link would be worse.
      return <span>{children}</span>;
    }
    return (
      <a href={safe} {...externalLinkAttributes(safe)} {...rest}>
        {children}
      </a>
    );
  },

  img({ src, alt }) {
    const safe = safeHref(typeof src === "string" ? src : undefined);
    if (!safe) {
      // A corpus path is not a URL this application can serve, so it is shown as a
      // reference rather than a broken image.
      return <em>{alt || "image"}</em>;
    }
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={safe} alt={alt ?? ""} loading="lazy" />;
  },

  table({ children }) {
    // A generated table can exceed the column width. It scrolls inside its own container,
    // which is focusable so the scroll is reachable from the keyboard.
    return (
      <div className="tableScroll" tabIndex={0} role="group" aria-label="Table, scrollable">
        <table>{children}</table>
      </div>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm];

function Markdown({ text }: { readonly text: string }): ReactNode {
  if (!text.trim()) {
    return null;
  }
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}
