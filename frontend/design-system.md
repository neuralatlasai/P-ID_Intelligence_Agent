# Industrial visual system — conversion contract

This document is binding for any change to presentation in this application. It exists
because the product must read as one instrument: a screenshot of Search, Canvas, a P&ID, a
3D view, a simulation or an agent investigation has to be recognisable as the same product
with the logo and navigation cropped out.

The single source of truth for values is [`src/styles/tokens.css`](src/styles/tokens.css).
This document says which token to reach for, and what not to do.

---

## 1. The one rule

**No presentation file contains a colour literal.** No hex, no `rgb()`, no `hsl()`, no
named colour — in CSS, in inline styles, in SVG attributes, in canvas `fillStyle` /
`strokeStyle`, or in Three.js material definitions. Every colour comes from a token.

For TypeScript that needs a colour (canvas 2D, Three.js, computed SVG), read the token
rather than hardcoding a matching value:

```ts
const ink = getComputedStyle(document.documentElement)
  .getPropertyValue("--ink-primary")
  .trim();
```

For SVG inside JSX, prefer `stroke="var(--ink-primary)"` / `fill="var(--ink-fill)"`
directly, or `currentColor` where the element should inherit.

If no token expresses what you need, that is a signal the design has drifted — raise it
rather than inventing a value. The token set is meant to be sufficient; additions are a
deliberate act, not a side effect of building a component.

---

## 2. Converting a light-mode value

The previous system was light. Do not translate literals one-for-one — translate the
**role** the literal was playing. The governing inversion:

> In a light system, **darker = more important**.
> In this system, **brighter = more important**.

So a near-black text colour becomes the *brightest* text token, and a white card surface
becomes a *panel* surface — not white.

### Surfaces

Identify what the element is, then take the token. Never pick by how light the old value
was.

| The element is                                         | Token                |
| ------------------------------------------------------ | -------------------- |
| Drawing canvas, 3D viewport, any engineering artefact backdrop | `--bg-void`      |
| Input, textarea, code block, inset well                 | `--bg-sunken`        |
| Page or region background                               | `--bg-canvas`        |
| Navigation, sidebars, secondary chrome                  | `--bg-subtle`        |
| Panel, card — the default content surface               | `--bg-surface`       |
| Panel header, table header, card nested in a card       | `--bg-surface-high`  |
| Hover state on any of the above                         | `--bg-hover`         |
| Selected row                                            | `--bg-selected`      |
| The one dominant action per view                        | `--bg-inverse`       |

### Text

| The text is                                                  | Token              |
| ------------------------------------------------------------ | ------------------ |
| The current/active item — the brightest thing on screen       | `--text-active`    |
| Body copy, values, headings, primary labels                   | `--text-primary`   |
| Supporting copy, descriptions, inactive nav, column headers   | `--text-secondary` |
| Metadata, counts, units, timestamps, captions                 | `--text-tertiary`  |
| A link                                                        | `--text-link`      |
| On `--bg-inverse` only                                        | `--text-inverse`   |

`--text-tertiary` is the floor. There is no dimmer text token, because there is no text in
this product that is allowed to fail AA. If something feels too loud at
`--text-tertiary`, make it smaller or move it — do not dim it.

### Borders

Almost everything is `--border-subtle`. Use `--border-strong` only where two regions of the
same surface level meet and genuinely need separating. Inside tables and diagrams, where a
border is too heavy, use `--rule-subtle`.

### The old blue

`#2563eb`, `#1d4ed8`, `#1e40af`, `#3b82f6` and relatives were doing three different jobs.
Separate them:

- **Filled button** → not blue any more. See §5 — it becomes a dark surface with a border,
  unless it is the one dominant action, which becomes `--bg-inverse`.
- **Link** → `--text-link`.
- **Selection / focus / active affordance** → `--accent-action`, or
  `--accent-action-subtle` for a wash.

### Semantic colour

| Old family                                    | Token family        |
| --------------------------------------------- | ------------------- |
| greens (`#22c55e`, `#16a34a`, `#15803d`, …)    | `--status-ready`    |
| reds (`#b91c1c`, `#dc2626`, `#ef4444`, …)      | `--status-down`     |
| ambers (`#f59e0b`, `#b7791f`, `#8a5a0f`, …)    | `--status-degraded` |
| violets (`#6d28d9`, `#7c3aed`, `#8b5cf6`, …)   | `--evidence-inferred` |

Each status has three variants and they are not interchangeable:

- `--status-x` — text. Clears 4.5:1.
- `--status-x-mark` — non-text marks only: dots, strokes, chart marks. Clears 3:1.
- `--status-x-bg` — the wash behind it. Alpha, so it composes over any surface.

Semantic colour marks *state the system has determined*. It never marks a category, a
brand, a decoration, or "this row is different". If you are colouring something that is
not a state, you want a surface, a border, or mono type — not a status token.

---

## 3. Typography

Two families, and the split is not stylistic:

**Mono** (`--font-mono`) carries anything an engineer reads character by character — tag
names, asset IDs, functional locations, equipment codes, units, timestamps, coordinates,
run and checkpoint identifiers, file paths, numeric values in tables.

**Sans** (`--font-sans`) carries human language — descriptions, prose, headings, button
labels, explanations.

A sentence *about* `P-1101A` is sans; the token `P-1101A` inside it is mono.

| Role                     | Size          | Weight | Notes                              |
| ------------------------ | ------------- | ------ | ---------------------------------- |
| Screen title             | `--text-3xl`  | 600    |                                    |
| Panel title              | `--text-lg`   | 600    |                                    |
| Body                     | `--text-base` | 400    |                                    |
| Metadata                 | `--text-sm`   | 500    |                                    |
| Section label            | `--text-sm`   | 500    | mono, uppercase, `--tracking-label` |
| KPI value                | `--text-2xl`  | 500    | mono, `tabular-nums`               |

Section labels follow the reference form — `01 ——— PROPERTIES`, `02 ——— LIVE TAGS` — in
uppercase mono at `--tracking-label`. They are structural markers, so they are numbered in
document order within a panel.

**Use the shared `.sectionLabel` class from `globals.css`.** Do not define a private copy
in a CSS module. It is the most repeated element of the grammar in the product, and five
private copies of it is how a system stops being one system.

Any column of numbers gets `.tabularNums` (also global), so digits share an advance width
and a changing value does not reflow the rows beside it.

---

## 4. Geometry

An 8px grid, with 4px available for micro-spacing inside controls. Use the `--space-*`
scale; do not write pixel values for spacing.

| Region                  | Token                        |
| ----------------------- | ---------------------------- |
| Global top bar          | `--header-height` (46px)     |
| Main navigation         | `--sidebar-width` (248px)    |
| — collapsed             | `--sidebar-width-collapsed`  |
| Context/category column | `--context-width` (216px)    |
| Right inspector         | `--rail-width` (360px)       |

The centre workspace takes the remaining width. It is never centred in a fixed measure —
the frame is full-width, because at 4K the answer is *more information*, not a wider
margin.

Two things are exempt, because more width does not give them more to say:
`--measure-max-width` still bounds prose inside an answer, where a long line hurts
reading; and a landing or empty state may keep a fixed measure, since it has a fixed
amount to show.

Radius: `--radius-sm` (4px) for controls, `--radius-md`/`--radius-lg` (6–8px) for floating
surfaces. `--radius-pill` is for true circles — status dots — and never for a container.

Adjacent engineering surfaces share borders and read as one structure. Cards do not float
apart from each other with independent shadows and gaps.

---

## 5. Components

**Buttons.** `--control-height-sm` (28px) to `--control-height-lg` (36px). The default is a
dark surface with a 1px border. **One** button per view may be filled — the dominant
contextual action — and it is filled with `--bg-inverse`, not a colour. A destructive
action is a default button whose label takes `--status-down`; it is not a red fill.

**Inputs.** 32–36px. `--bg-sunken` with `--border-subtle`. Rectangular — no pill shapes.

**Rows** (trees, tables, lists). `--row-height` (30px). Hierarchy is communicated by
indentation, not by vertical spacing. A selected row gets `--bg-selected` plus a 2px
`--accent-action` left indicator and `--text-active` label. Do not fill a selected row
with a bright colour.

**Icons.** One outline family, 16–18px, ~1.5px stroke, `currentColor`.

**Status dots.** 7px, `--radius-pill`, `--status-x-mark`.

---

## 6. Prohibited

These are the patterns that broke the previous system. None of them appear in the
converted product:

- Colour literals in any presentation file (§1)
- Gradients as surfaces — `linear-gradient`, `radial-gradient` — including on buttons,
  headers, banners and progress bars.
  **One exception:** the dotted engineering field, which cannot be painted any other way.
  Use the shared `.engineeringField` class from `globals.css`; do not hand-roll it.
- `backdrop-filter` / glassmorphism
- Shadow used for decoration. `--shadow-md`/`--shadow-lg` exist for menus, dialogs and
  drawers — surfaces that genuinely float. Resting cards have no shadow.
- Pill-shaped containers (`border-radius: 999px` on anything but a dot)
- Radii above 8px
- Saturated fills — a coloured button, a bright selected row, a neon chart trace
- Colour as decoration or as a category key where mono type or a border would serve
- Ambient animation: telemetry pulses, drifting gradients, particles, "AI thinking"
  effects. Motion encodes runtime activity or a state change, or it is removed.
- `!important`, except in the existing reduced-motion reset

---

## 7. Motion

| What is moving              | Token                   |
| --------------------------- | ----------------------- |
| Hover                       | `--duration-hover`      |
| Button / state change       | `--duration-fast`       |
| Panel open/close            | `--duration-panel`      |
| Inspector transition        | `--duration-inspector`  |
| Canvas focus                | `--duration-canvas`     |
| 3D camera transition        | `--duration-camera`     |

Entry uses `--easing-standard`; anything moving through space uses `--easing-spatial`.
Everything honours `prefers-reduced-motion` — and note that a *transition* is neutralised
by the duration tokens going to `0ms`, but a keyframe `animation` is not, so any animation
needs its own reduced-motion rule.

---

## 8. Charts

Charts are part of the application surface, not embedded widgets. They sit on
`--bg-surface` with no border of their own when they fill a panel.

Series are taken in order: a single-series chart uses `--series-1` and nothing else. Axes
use `--chart-axis`, grid `--chart-grid`, crosshair `--chart-crosshair`. Units, timestamps
and tick labels are mono at `--text-sm` in `--text-tertiary`.

Anomalies and alarms are sparse marks at `--status-x-mark` — a marked point or a short
rule, not a permanently recoloured trace.

Live values interpolate over 150–300ms. Historical data does not animate.

---

## 8b. Engineering artefacts on light paper

The `--overlay-*` tokens assume the artefact is ink on void — that is what makes a
selection box readable over it. Most P&ID rasters are the opposite: black line-work on
white paper. Dropped onto a dark workspace unchanged, the sheet becomes the brightest
object on screen and every overlay has to fight its substrate.

Do not solve this with a second set of overlay colours. **Normalise the artefact instead**,
with the shared `.engineeringRaster` class from `globals.css`, which inverts the sheet to
ink-on-void while returning meaningful engineering colours to approximately their original
hue. The overlay tokens then work as specified, and a selection reads identically whether
it is drawn on a vector diagram, a raster scan, a photograph or a 3D view — which is the
whole point of fixing their weights.

Two rules for using it:

- **It goes on the element that *is* the artefact**, never on an ancestor that also carries
  chrome. A filter applies to the element's own background and border as well, so the class
  clears both; to frame or inset a normalised sheet, wrap it and style the wrapper. Inside
  an SVG, put it on the `<image>` alone, so the overlay marks above it are not inverted too.
- **It is for paper, not for photographs.** A scan of a drawing is ink on a substrate and
  normalising it recovers the drawing. A photograph of equipment is a picture of the world;
  inverting it produces a false-colour image, not a dark-mode one.

---

## 9. Canvas and 3D

2D canvases scale their backing buffer by `devicePixelRatio` so they are not soft on
high-DPI displays. Expensive 3D clamps to `min(devicePixelRatio, 2)`.

The 3D scene is technical, not cinematic: `--scene-bg` environment, neutral
`--scene-material`, restrained metallic response, one soft key light plus weak ambient.
Selection brightens the material to `--scene-material-selected` and adds a thin
`--scene-outline` edge — it never tints the geometry.

Spatial graphics that describe the world live in world coordinates and stay attached to
their geometry as the camera moves. Only labels and tooltips are screen-space.

---

## 10. What a conversion must not change

Presentation only. A conversion does not alter:

- Component behaviour, state, props or data flow
- DOM structure, except where a purely presentational wrapper is added or removed
- Accessible names, roles, `aria-*`, or heading hierarchy
- Test selectors — `data-testid`, `getByRole` names, `aria-label` text
- Copy

---

## 11. Verifying

```
npm run gate            # format, lint, typecheck, contrast, unit tests, build
npm run check:contrast  # every text token against every surface it can appear on
npm run test:e2e        # includes the accessibility scans
```

`check:contrast` reads `tokens.css` directly, so the AA claim in §2 is measured rather
than asserted. If you add a text or mark token, add it to the audit's list — a token that
is not in the list is not checked.

The screenshot harness in `tests/e2e/surface-review.spec.ts` writes every surface to
`qa/review-<project>-<surface>.png` across three viewports. Look at them. The acceptance
criterion is not "the tests pass" — it is that the surfaces read as one instrument.

A file is converted when:

```sh
# returns nothing
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' <file>
grep -nE 'linear-gradient|radial-gradient|backdrop-filter' <file>
```

(`rgb()` with alpha is permitted in `tokens.css` alone, where the washes are defined.)
