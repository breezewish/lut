# Preview Cache Performance Tests

- Two real RAW entries retain independent EV and Look edits, keep old tiles visible while progressively regenerating all Look thumbnails after EV changes, and return to the first photo without another RAW decode.
- Startup requests all LUTs concurrently through hash-versioned browser-cache URLs, and each Look thumbnail publishes before the complete batch finishes.
- Continuous slider input keeps only the newest waiting EV, paints Worker-created 256px bitmap interaction frames without UI-thread RGBA churn, persists the idle or final EV, and publishes one final 1024px frame before enabling export.
- Pointer-down without an EV change retains 1024px, while 80 ms without input after a change refines to 1024px even if the pointer remains down.
- LUT selection paints a 256px Worker bitmap before its 1024px Worker bitmap without a UI-thread RGBA transfer.
- A ready-photo SwiftShader drag with 4× CPU throttling rejects repeated long tasks and main-thread frame gaps large enough to recreate the reported UI freeze.
- Six GPU sources remain reusable while the seventh evicts only the least-recently-used source; UI comparison and thumbnail buffers remain bounded to three photos.
- Removing one photo releases only its cached preview while clearing the queue releases every preview.
- Retained GPU sources share one LUT and output/readback workspace; smaller sources allocate no new workspace, a larger source grows it once, and renderer release does not release source buffers.
