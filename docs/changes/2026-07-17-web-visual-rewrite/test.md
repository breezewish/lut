# Web Visual Rewrite Tests

No new end-to-end cases were added — this is a presentation-only rewrite.
The full behavioral coverage list in `docs/ssot/web/test.md` applies
unchanged and re-passed against the new markup and stylesheet.

- Three assertions converted from CSS class matching to `data-variant`
  attribute / accessible-name matching continue to verify the same primary
  vs. secondary export-button treatment and drop-target behavior.
- Manual desktop/tablet/mobile × light/dark screenshots verified the canvas
  remains the dominant surface and preview panes fill their full available
  height at every breakpoint.
