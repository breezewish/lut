# Web Visual Rewrite Specification

## Goal

Replace the web app's entire CSS, layout, and component visual treatment with a
ground-up design — flat, restrained, no shadows or decorative borders — while
keeping every existing product behavior, journey, and accessibility contract
in `docs/ssot/web/spec.md` unchanged.

## Motivation

The shipped desktop layout had regressed against its own documented intent:
the Adjustments/Output panel occupied the wide grid track and the Base/LUT
comparison canvas was compressed into a narrow strip, contradicting "the
center canvas... remains the largest surface" in `docs/spec.md`. Screenshotting
the running app confirmed this empirically before any redesign work began.

## Requirements

- The comparison canvas is the dominant visual surface at every breakpoint.
- Queue and inspector are narrow rails; no layout regresses to the inverted
  proportions above.
- No color, spacing, radius, or typography value is carried over unexamined
  from the previous stylesheet — every token is re-derived and contrast
  is verified.
- Every ARIA role, accessible name, visible string, and behavioral state
  class (`is-fit`, `is-actual`, status classes) asserted by the existing
  Playwright and Vitest suites is preserved exactly.
- Tests that asserted on presentational CSS class names (button variant
  classes, drop-zone element, panel heading) are converted to role/label/
  data-attribute assertions per `AGENTS.md`'s behavior-driven testing rule.

## Non-goals

- No change to product behavior, the processing pipeline, or the CLI.
- No new features; this is a presentation-layer rewrite only.
