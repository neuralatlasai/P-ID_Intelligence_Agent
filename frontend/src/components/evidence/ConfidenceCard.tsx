"use client";

import { Card } from "@/components/ui/Card";
import type { EvidenceSupport } from "@/lib/responses/sections";

import styles from "./evidence.module.css";

export interface ConfidenceCardProps {
  readonly support: EvidenceSupport;
}

/**
 * Evidence support, stated categorically.
 *
 * There is no numeric confidence here, and there will not be one until the backend
 * produces a value calibrated against known outcomes. A number a model emits is not
 * calibrated merely because a model emitted it, and a figure such as "0.94" in a card
 * labelled Confidence invites an engineer to act on a precision that does not exist.
 *
 * The meter is a four-segment arc showing a categorical position, not a percentage. The
 * card always states the category in words, and says plainly when the answer made no
 * statement at all.
 */
export function ConfidenceCard({ support }: ConfidenceCardProps) {
  const presentation = PRESENTATION[support];

  return (
    <Card title="Evidence support">
      <div className={styles.support}>
        <SupportMeter tone={presentation.tone} filled={presentation.filled} />
        <div className={styles.supportText}>
          <p className={styles.supportLabel} style={{ color: presentation.color }}>
            {presentation.label}
          </p>
          <p className={styles.supportNote}>{presentation.note}</p>
        </div>
      </div>
    </Card>
  );
}

interface Presentation {
  readonly label: string;
  readonly note: string;
  readonly color: string;
  readonly tone: string;
  readonly filled: number;
}

const PRESENTATION: Readonly<Record<EvidenceSupport, Presentation>> = {
  supported: {
    label: "Supported",
    note: "The answer reports directly observed or independently corroborated evidence. Calibrated score unavailable.",
    color: "var(--evidence-observed)",
    tone: "var(--evidence-observed)",
    filled: 4,
  },
  partial: {
    label: "Partial",
    note: "Some claims are inferred rather than observed. Calibrated score unavailable.",
    color: "var(--evidence-inferred)",
    tone: "var(--evidence-inferred)",
    filled: 2,
  },
  conflicting: {
    label: "Conflicting",
    note: "Sources disagree. Read the conflicts section before acting on this answer. Calibrated score unavailable.",
    color: "var(--evidence-conflicting)",
    tone: "var(--evidence-conflicting)",
    filled: 1,
  },
  insufficient: {
    label: "Insufficient",
    note: "The corpus does not support a conclusion. The answer states what is missing. Calibrated score unavailable.",
    color: "var(--status-degraded)",
    tone: "var(--status-degraded)",
    filled: 1,
  },
  not_assessed: {
    label: "Not assessed",
    note: "The answer made no statement about how well it is supported. No score is inferred, and no calibrated score is available.",
    color: "var(--text-tertiary)",
    tone: "var(--border-default)",
    filled: 0,
  },
};

/**
 * A four-segment categorical meter.
 *
 * Segments, not an arc sweep: a continuous arc reads as a percentage, and there is no
 * percentage here to read.
 */
function SupportMeter({
  tone,
  filled,
}: {
  readonly tone: string;
  readonly filled: number;
}) {
  const segments = [0, 1, 2, 3];
  return (
    <svg
      className={styles.supportMeter}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      {segments.map((index) => {
        const start = -90 + index * 90 + 6;
        const end = start + 78;
        return (
          <path
            key={index}
            d={arcPath(20, 20, 15, start, end)}
            fill="none"
            strokeWidth={4}
            strokeLinecap="round"
            stroke={index < filled ? tone : "var(--bg-sunken)"}
          />
        );
      })}
    </svg>
  );
}

function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDegrees: number,
  endDegrees: number,
): string {
  const start = polar(cx, cy, radius, startDegrees);
  const end = polar(cx, cy, radius, endDegrees);
  const largeArc = endDegrees - startDegrees > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function polar(cx: number, cy: number, radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}
