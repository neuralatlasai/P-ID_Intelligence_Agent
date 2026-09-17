# Six-asset fusion workspace design QA

## Comparison target

- Source visual truth: `image.png` (1203 x 402 px).
- Combined comparison: `qa/fusion-comparison.png` (1600 x 1603 px).
- Evidence map: `qa/fusion-evidence-final.png` (1600 x 980 px).
- Asset investigation: `qa/fusion-asset-final.png` (1600 x 1432 px full page).
- AI brief: `qa/fusion-brief-final.png` (1600 x 980 px).
- Browser viewport: 1600 x 980 CSS px, device scale factor 1.
- State: production build, backend corpus connected, ANN-001 selected on page 1 and
  ANN-006 selected on pages 2 and 3.
- Density normalization: the 1203 px source reference was proportionally scaled to 1600 px
  wide in the combined comparison; implementation captures remained at native 1x density.

## Full-view comparison evidence

- The implementation preserves the reference's dark tool rail, white dotted canvas,
  floating linked evidence, source P&ID, purple selection language, trend card, and
  assistant summary panel.
- The reference's overlapping windows are represented as three explicit pages. This is an
  intentional interaction adaptation that keeps the same evidence-map -> investigation ->
  assistant sequence while making every state directly reachable and testable.
- Six generated plant images now occupy the evidence surface as a coherent 3 x 2 fusion
  set. Every image shows its editable ANN identifier, detected subject box, generated
  provenance badge, and GraphML node ID.

## Focused-region comparison evidence

- `qa/fusion-asset-final.png` verifies ANN-006 at readable scale: the pressure-gauge box,
  `instrumentation15` marker on the P&ID, field-reference class, incident-edge count,
  direct neighbour, provenance, and mapping state agree.
- `qa/fusion-brief-final.png` verifies that the selected record carries into the assistant
  summary and that `6/6 mapped annotations` remains visible.
- Automated coordinate checks repeat this validation for ANN-001 through ANN-006 by
  comparing the marker's `data-source-x` and `data-source-y` with the live GraphML response.

## Required fidelity surfaces

- Fonts and typography: passed. Segoe UI/system typography keeps the compact enterprise
  hierarchy, readable small labels, stable wrapping, and clear emphasis used by the source.
- Spacing and layout rhythm: passed. Six thumbnails, drawing, mapping panel, observation,
  trend, and assistant regions align to a consistent grid at desktop-wide, desktop-narrow,
  and 390 px mobile widths. No horizontal document overflow remains.
- Colors and visual tokens: passed. Neutral canvas, dark navigation, purple interaction,
  green linkage status, and red annotation tokens are consistent. Axe reports zero WCAG
  A/AA violations across all three pages and all three configured viewports.
- Image quality and asset fidelity: passed. All six 4:3 generated images are high-resolution,
  photorealistic, consistently lit, correctly cropped, and stored as real project assets.
  No placeholder or CSS-drawn plant imagery remains.
- Copy and content: passed. Corpus, generated, and simulated information are named
  explicitly. Image resemblance is never described as proof of plant identity.

## Mapping and interaction validation

- ANN-001 -> tank67 -> vertical process separator.
- ANN-002 -> tank70 -> vertical process drum.
- ANN-003 -> valve43 -> pneumatic globe control valve.
- ANN-004 -> valve38 -> handwheel gate valve.
- ANN-005 -> instrumentation14 -> electronic pressure transmitter.
- ANN-006 -> instrumentation15 -> analog pressure gauge.
- Every record changes the P&ID marker to the exact GraphML coordinate and refreshes class,
  topology, annotation, provenance, and assistant context from the same typed object.
- The backend request contains the complete six-record manifest and instructs the agent to
  re-verify each requested node against GraphML before making an observed claim.
- The main navigation, all selectors, the assistant composer, backend stream, keyboard
  focus, and responsive states were exercised. Browser console errors: none.

## Comparison history

1. Earlier implementation showed only one generated visual. This was a P1 coverage gap.
   Fixed by generating six class-matched assets and introducing six typed fusion records.
2. Initial six-record pass omitted the human-readable field class on the detail table.
   This was a P2 traceability gap. Fixed by exposing `fieldClass` beside the corpus class.
3. Initial thumbnail overlay labels inherited the selector's purple text token. This was a
   P2 accessibility issue. Fixed with a white-on-dark-red annotation-label override.
4. Post-fix evidence: `qa/fusion-comparison.png`, `qa/fusion-asset-final.png`, and
   `qa/fusion-brief-final.png`; the final Playwright run passed coordinate, accessibility,
   responsive, navigation, and assistant-stream checks.

## Findings

No actionable P0, P1, or P2 visual, mapping, responsive, accessibility, or interaction
finding remains. The unavailable 3D model, map, historian, and work-order sources shown in
the reference are not fabricated; their positions are represented by labeled simulation
context until real connectors exist.

## Follow-up polish

- P3: replace generated field references with approved plant photographs if those sources
  become available; the annotation and provenance contract requires no structural change.

final result: passed
