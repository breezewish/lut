# Browser RAW Alchemy Change Tests

- The pinned Python environment regenerates the committed legacy checkpoint archive and manifest from the hashed RAW and all 27 supported LUT inputs, with separate export and preview results.
- Native debug and optimized Rust pass the complete workspace suite against legacy and corrected behavior.
- Corrected matrix vectors include direct linear-sRGB output from pinned LibRaw, independently checking the numerical ProPhoto D65 basis.
- A multi-strip core test proves bounded, contiguous strip rendering and independently decodable Deflate output.
- Core tests prove row-fed preview sampling retains exactly the pixels used by the requested display size and rejects incomplete or inconsistent input.
- A browser adapter test proves export reads only bounded source views and rejects inconsistent encoder strip requests.
- A production binding check proves LibRaw returns bounded zero-copy RGB16 views instead of a complete JavaScript image, the preview constructor receives no RGB16 image, only requested source rows cross into Rust WASM, EV rerenders receive no source or CUBE data, transferred RGBA8 is reinterpreted without another complete Canvas-side copy, and whole-image TIFF export is not exposed.
- The static production build contains custom LibRaw WASM, Rust core WASM, and all hash-verified creative LUTs.
- The parity harness requires bounded RGB16 slices to share LibRaw WASM memory and out-of-bounds views to fail; synthetic LinearRaw and real-CFA half-size outputs are sample-exact, while full-size real-CFA output is sample-exact inside the image with one bounded AAHD outer-edge exception.
- CLI integration covers readable RGB16 TIFF output, JSON-without-ANSI, forced and suppressed text color, corrupt input, and destination write failure without a false output.
- A real C translation unit compiles against the public computation header, links the produced library, renders a corrected-v2 TIFF, and releases its owned output buffer.
- Playwright exercises HTTPS production bundles in Chromium, Firefox, and WebKit; non-secure remote development HTTP; embedded camera JPEGs; real Leica DNG and Sony ARW decode and export; same-origin-only network activity; accessible queue and preview state; populated-queue drop and same-event deduplication; chooser deduplication, remove and undo, recent looks, rapid selection races, and mixed-success batch export; immutable batch recipes with editing locked; hash mismatch, missing and malformed LUT recovery; worker and WASM failures; short-desktop export reachability; and the mobile empty-state task order.
- Layout and critique audits leave no unresolved detector or human-review findings.
