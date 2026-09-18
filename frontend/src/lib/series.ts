/**
 * Categorical chart colour.
 *
 * A series takes its colour from its position, not from a value stored beside it. That
 * makes "in order" structural: a chart cannot drift out of step with its legend, and
 * nobody has to maintain a hex in a data module to keep them agreeing.
 *
 * This lives in one place because it was previously copied into six components, each with
 * its own `SERIES_COUNT = 6`. Two of those charts can carry eight channels, so the seventh
 * wrapped and rendered identically to the first — in the same chart. A shared definition
 * is the only way the guarantee holds.
 *
 * See design-system.md §8, and the `--series-*` block in tokens.css for why the family
 * stops at eight.
 */

/** How many categorical series the token set defines. */
export const SERIES_COUNT = 8;

/**
 * The token for the series at `index` (0-based).
 *
 * Wraps if there are more series than tokens, which is a visible collision rather than a
 * crash — but a catalogue that reaches that point wants grouping, not another colour.
 */
export const seriesColour = (index: number): string =>
  `var(--series-${(Math.max(0, index) % SERIES_COUNT) + 1})`;

/** How many steps the sequential ramp defines. */
export const SCALE_STEPS = 5;

/**
 * The token for a magnitude in `0..1`, for heatmap cells and density.
 *
 * Distinct from `seriesColour` on purpose: this ramp varies only brightness, so the eye
 * can order it, whereas the series family is near-equal in luminance so no category
 * outranks another. Using one for the other's job is the most common way a chart stops
 * being readable. A true zero — as opposed to the lowest measured value — belongs on
 * `--bg-sunken`, off the ramp entirely.
 */
export const scaleColour = (intensity: number): string => {
  const clamped = Math.min(1, Math.max(0, intensity));
  const step = Math.min(SCALE_STEPS, Math.max(1, Math.ceil(clamped * SCALE_STEPS)));
  return `var(--scale-${step})`;
};
