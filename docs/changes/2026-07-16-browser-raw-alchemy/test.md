# Browser RAW Alchemy Change Tests

- The pinned Python environment regenerates the committed legacy checkpoint archive and manifest from the hashed RAW and all 27 supported LUT inputs, with separate export and preview results.
- Native debug and optimized Rust pass the complete workspace suite against legacy and corrected behavior.
- Corrected matrix vectors include direct linear-sRGB output from pinned LibRaw, independently checking the numerical ProPhoto D65 basis.
- A multi-strip core test proves bounded, contiguous strip rendering and independently decodable Deflate output.
- Core tests prove row-fed preview sampling retains exactly the pixels used by the requested display size and rejects incomplete or inconsistent input.
- A browser adapter test proves export reads only bounded source views and rejects inconsistent encoder strip requests.
- A production binding check proves LibRaw returns bounded zero-copy RGB16 views instead of a complete JavaScript image, the preview constructor receives no RGB16 image, only requested source rows cross into Rust WASM, EV rerenders receive no source or CUBE data, transferred RGBA8 is reinterpreted without another complete Canvas-side copy, and whole-image TIFF export is not exposed.
- The static production build contains custom LibRaw WASM, Rust core WASM, and all hash-verified creative LUTs.
- The parity harness requires bounded RGB16 slices to share the LibRaw WASM memory, out-of-bounds views to fail, and native and WASM LibRaw to decode the deterministic DNG to exactly the same dimensions and samples.
- CLI integration covers readable RGB16 TIFF output, JSON-without-ANSI, forced and suppressed text color, corrupt input, and destination write failure without a false output.
- A real C translation unit compiles against the public computation header, links the produced library, renders a corrected-v2 TIFF, and releases its owned output buffer.
- Playwright exercises an embedded camera JPEG, same-origin-only network activity, real browser RAW decode, accessible queue/preview state and single-primary-action hierarchy, positive slider and directly typed negative EV plus LUT rerender without re-decode, optimized native/WASM final TIFF equivalence within one code value for all 27 LUTs, two different batch inputs independently matching native output, stop-after-current partial export, recoverable corrupt-file and WASM-startup failures, short-desktop export reachability, and the mobile empty-state task order.
- Layout and critique audits leave no unresolved detector or human-review findings.
