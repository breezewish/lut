# Web UI Redesign Design

## Introduction

The application uses a compact three-zone editing shell inspired by professional image tools while preserving LUTify's focused single-workflow scope.

## Detailed Design

The top toolbar owns document-level actions and status. A source queue occupies the left region, Base/LUT comparison fills the center, and a right inspector groups adjustments above output. Surface fills create hierarchy without borders or shadows. Both themes use neutral OKLCH tokens and retain dark image wells for color judgment.

At medium widths the queue becomes horizontal. Below 700 px the application becomes a vertical workflow. The two previews remain side by side until 560 px, then stack. Theme preference is stored locally and affects presentation only.

## Trade-offs

A fixed inspector reduces canvas width compared with an overlay, but it keeps controls discoverable and prevents modal state. The medium-width horizontal queue preserves comparison width better than a permanently narrow three-column layout.

## Test Plan

Unit tests cover theme persistence and existing interaction behavior. Browser tests cover theme reload, empty mobile IA, short-height export reachability, real RAW preview, and export behavior. Desktop, tablet, and mobile screenshots verify layout and both themes.

## Open Questions

None.
