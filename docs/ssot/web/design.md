# Web Design

## Runtime

React owns queue and control state. `ProcessingClient` pairs commands with worker replies. One promise tail in the Dedicated Worker serializes decode, rerender, and export, preventing LibRaw state races and batch contamination.

The worker loads each LUT on demand, verifies SHA-256 with Web Crypto, parses it in Rust, and retains only the current source. It retains one half-size decoded preview. Export receives a fresh transferable RAW buffer and performs a full decode only for that operation.

## Presentation

Tailwind supplies utility infrastructure and a small Shadcn-style component layer uses Radix Select. A separate search field filters the grouped Select without replacing its familiar keyboard behavior; recent LUT identifiers are a nonessential local preference. Product layout and tokens live in `styles.css`. Neutral OKLCH surfaces provide hierarchy without borders or shadows. Rose identifies primary actions and selection; amber identifies the unverified output assumption.

Editing controls precede comparison in the DOM and the selected-file export follows it. Empty states omit editing and export controls. At medium width the file queue becomes horizontal and controls wrap by semantic group while previews remain side by side. At narrow mobile width controls become full-width and previews stack. Add, recovery, and destructive row actions remain visible on touch layouts.

Batch export has one mutable operation state: the current index, total, and file name. Stop requests are checked after the active file finishes, preserving the single-worker execution model. Per-file failures update that queue item and do not abort remaining eligible files. Completed TIFFs are already Deflate-compressed, so the main thread streams them into a pass-through ZIP instead of retaining a second file map, recompressing them, or assembling another contiguous archive copy. The final ZIP chunks remain in memory because portable browser downloads require a Blob; direct filesystem streaming is not assumed.
