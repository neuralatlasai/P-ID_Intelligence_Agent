/**
 * Contrast audit for the design tokens.
 *
 * Section 11 of the visual brief requires WCAG AA. That is a claim about the token set,
 * so it is checked against the token set rather than asserted in a comment: every text
 * token is measured against every surface it can appear on, and every non-text mark
 * against the surface behind it.
 *
 * The surfaces and roles below are read from tokens.css by name, so this stays honest as
 * the palette changes — a renamed or deleted token fails loudly rather than silently
 * dropping out of the audit.
 *
 *   node scripts/check-contrast.mjs
 *
 * Exits non-zero if anything fails, so it can be wired into the gate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "styles", "tokens.css"), "utf8");

/** Every `--name: value;` declaration in the token file. */
const tokens = new Map(
  [...source.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [
    name,
    value.trim(),
  ]),
);

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** Surfaces text can sit on, darkest first. */
const SURFACES = [
  "--bg-void",
  "--bg-sunken",
  "--bg-canvas",
  "--bg-subtle",
  "--bg-surface",
  "--bg-surface-high",
  "--bg-selected",
  "--bg-hover",
];

/** Tokens used for text. Each must clear 4.5:1 on every surface above. */
const TEXT = [
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-active",
  "--text-link",
  "--status-ready",
  "--status-degraded",
  "--status-down",
  "--status-unknown",
  "--evidence-observed",
  "--evidence-corroborated",
  "--evidence-inferred",
  "--evidence-conflicting",
  "--evidence-unknown",
  "--ink-primary",
  "--ink-secondary",
];

/** Tokens used for marks, strokes and chart series. These answer to 3:1. */
const NON_TEXT = [
  "--status-ready-mark",
  "--status-degraded-mark",
  "--status-down-mark",
  "--status-unknown-mark",
  "--rule-strong",
  "--ink-muted",
  "--series-1",
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
  "--series-7",
  "--series-8",
];

/*
 * The sequential scale is exempt from the per-surface threshold: its low steps are meant
 * to sit near the surface, because "almost none" should look like almost nothing. What it
 * owes instead is that consecutive steps are tellable apart, which is checked below.
 */
const SCALE = ["--scale-1", "--scale-2", "--scale-3", "--scale-4", "--scale-5"];
/** Minimum contrast between neighbouring steps of a sequential ramp. */
const SCALE_STEP = 1.45;

/** Pairs that are their own foreground/background relationship. */
const PAIRS = [["--action-fill-text", "--action-fill"]];

function channel(value) {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const failures = [];
const missing = [];

function resolve(name) {
  const value = tokens.get(name);
  if (!value) {
    missing.push(name);
    return null;
  }
  if (!value.startsWith("#")) {
    // Alpha washes compose over an unknown surface; they are not audited here.
    return null;
  }
  return value;
}

function audit(names, threshold, label) {
  for (const name of names) {
    const value = resolve(name);
    if (!value) continue;
    for (const surfaceName of SURFACES) {
      const surface = resolve(surfaceName);
      if (!surface) continue;
      const ratio = contrast(value, surface);
      if (ratio < threshold) {
        failures.push(
          `${label}: ${name} on ${surfaceName} = ${ratio.toFixed(2)} (needs ${threshold})`,
        );
      }
    }
  }
}

audit(TEXT, AA_TEXT, "text");
audit(NON_TEXT, AA_NON_TEXT, "mark");

// The surface ladder must actually be a ladder. The token file documents it as ordered
// darkest-to-lightest and the whole system reasons in those terms — "one step up" has to
// mean something. A surface edited out of order would break that silently.
let previousSurface = null;
for (const name of SURFACES) {
  const value = resolve(name);
  if (!value) continue;
  if (previousSurface && luminance(value) <= luminance(previousSurface.value)) {
    failures.push(`ladder: ${name} is not lighter than ${previousSurface.name}`);
  }
  previousSurface = { name, value };
}

// A sequential ramp is only readable if each step is distinguishable from the one beside
// it, and monotonic — a ramp that dips is worse than no ramp, because it reads as ordered
// while being wrong.
let previous = null;
for (const name of SCALE) {
  const value = resolve(name);
  if (!value) continue;
  if (previous) {
    const ratio = contrast(value, previous.value);
    if (ratio < SCALE_STEP) {
      failures.push(
        `scale: ${previous.name} → ${name} = ${ratio.toFixed(2)} (needs ${SCALE_STEP})`,
      );
    }
    if (luminance(value) <= luminance(previous.value)) {
      failures.push(`scale: ${name} is not brighter than ${previous.name}`);
    }
  }
  previous = { name, value };
}

// Status text sits on its own translucent wash — a chip, a highlighted row — and the wash
// composes over whatever surface is beneath it. Measure each text colour on its wash over
// every surface; this is where the thinnest margins are, and an opaque-only audit misses it.
const WASHED = [
  ["--status-ready", "--status-ready-bg"],
  ["--status-degraded", "--status-degraded-bg"],
  ["--status-down", "--status-down-bg"],
  ["--status-unknown", "--status-unknown-bg"],
  ["--evidence-observed", "--evidence-observed-bg"],
  ["--evidence-corroborated", "--evidence-corroborated-bg"],
  ["--evidence-inferred", "--evidence-inferred-bg"],
  ["--evidence-conflicting", "--evidence-conflicting-bg"],
  ["--evidence-unknown", "--evidence-unknown-bg"],
  ["--text-link", "--accent-action-subtle"],
];

/** Parse `rgb(r g b / a%)` into its channels and alpha. */
function parseWash(value) {
  const match = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)/.exec(value);
  return match
    ? { rgb: match.slice(1, 4).map(Number), alpha: Number(match[4]) / 100 }
    : null;
}

const toHex = (rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

for (const [textName, washName] of WASHED) {
  const text = resolve(textName);
  const washValue = tokens.get(washName);
  const wash = washValue ? parseWash(washValue) : null;
  if (!text || !wash) {
    if (!washValue) missing.push(washName);
    continue;
  }
  for (const surfaceName of SURFACES) {
    const surface = resolve(surfaceName);
    if (!surface) continue;
    const base = fromHex(surface);
    const composite = toHex(base.map((v, i) => v + (wash.rgb[i] - v) * wash.alpha));
    const ratio = contrast(text, composite);
    if (ratio < AA_TEXT) {
      failures.push(
        `washed: ${textName} on ${washName} over ${surfaceName} = ${ratio.toFixed(2)} (needs ${AA_TEXT})`,
      );
    }
  }
}

for (const [fg, bg] of PAIRS) {
  const a = resolve(fg);
  const b = resolve(bg);
  if (!a || !b) continue;
  const ratio = contrast(a, b);
  if (ratio < AA_TEXT) {
    failures.push(`pair: ${fg} on ${bg} = ${ratio.toFixed(2)} (needs ${AA_TEXT})`);
  }
}

if (missing.length > 0) {
  console.error("Tokens named in the audit but absent from tokens.css:");
  for (const name of missing) console.error(`  ${name}`);
}

if (failures.length > 0) {
  console.error(`\nContrast failures (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
}

if (missing.length > 0 || failures.length > 0) {
  process.exit(1);
}

const checked =
  (TEXT.length + NON_TEXT.length + WASHED.length) * SURFACES.length + PAIRS.length;
// Written directly rather than via console.log: the project's lint rule allows only warn
// and error on the console, and a success line is neither.
process.stdout.write(`Contrast OK — ${checked} token/surface pairs meet WCAG AA.\n`);
