# Web Visual Rewrite Design

## Introduction

A precision-photography-tool aesthetic: numeric, tight density, restrained
color, evolved from the existing spectral-blue accent rather than a fresh
anchor hue (brand continuity was an explicit choice, not a default).

## Detailed Design

Color is OKLCH throughout with exactly two text tones (`--ink`, `--ink-muted`),
both verified at or above 4.5:1 contrast against every surface they sit on.
A third neutral (`--line`) is decoration-only — hairlines, exposure tick
marks, disabled glyphs — and never carries text; an earlier three-tone plan
collapsed the bottom two tones into visual indistinguishability once both
were pushed to pass contrast, so the tertiary tone was demoted to
decoration-only rather than shipped as a barely-legible third text tier.

The `.workbench` shell is a queue rail, a `.stage` containing the `.editor`.
Inside `.editor`, the inspector precedes the canvas in DOM order (so
Adjustments and Output form one uninterrupted Tab sequence) while CSS
`order` renders the canvas first/dominant and the inspector as a narrow
trailing rail — decoupling accessible traversal order from visual weight
instead of contorting the DOM to match visual order.

Queue item status is an icon (queued/decoding/ready/done/error), not a
colored accent stripe on the row edge — accent stripes on list rows are a
recognized lazy-decoration pattern, and an icon carries strictly more
information (shape plus color) for the same visual weight.

`Button` variant and size are rendered as `data-variant`/`data-size`
attributes rather than relying on generated class names, so the visual
system can be restyled freely without coupling to test assertions.

## Trade-offs

Collapsing to two text tones instead of three sacrifices one level of
de-emphasis (e.g. a true "tertiary" caption tone) in exchange for every
tone being unconditionally legible; the impeccable design skill's own
contrast guidance flags a barely-passing gray tertiary tone as the most
common way AI-generated interfaces become hard to read, so this trade
was taken deliberately rather than chasing a three-tier hierarchy that
would sit right at the contrast floor.

Decoupling DOM order from visual order via `order` (instead of physically
interleaving Adjustments / Canvas / Output as three DOM siblings) keeps the
inspector as one coherent, contiguous keyboard/screen-reader region. A
literal `adjust, canvas, export` DOM order was considered and rejected: it
would split one logical control panel across two landmarks with the same
accessible name, which is worse for landmark navigation than a single
`order`-repositioned canvas.

## Test Plan

Existing Vitest and Playwright suites are the test plan; no new test
behavior is introduced by a presentation-only rewrite. Three test
assertions were converted from CSS-class matching to attribute/role
matching (button variant, drop-zone element, panel heading selector) per
`AGENTS.md`'s behavior-driven testing rule — see
`docs/ssot/web/test.md` for the unchanged behavioral coverage list.
Desktop, tablet, and mobile screenshots in both themes verified the
canvas-dominant layout and full-height preview panes before merge.

## Open Questions

None.
