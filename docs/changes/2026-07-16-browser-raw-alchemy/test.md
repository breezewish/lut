# Browser RAW Alchemy Change Tests

- The pinned Python environment regenerates the committed legacy checkpoint archive and manifest from the hashed RAW and all 27 supported LUT inputs, with separate export and preview results.
- Native debug and optimized Rust pass the complete workspace suite against legacy and corrected behavior.
- A multi-strip core test proves bounded, contiguous strip rendering and independently decodable Deflate output.
- A browser adapter test proves the generated WASM binding receives only bounded source views and rejects inconsistent encoder strip requests.
- A production binding check proves preview pixels cross into Rust WASM only during renderer construction, EV rerenders do not reparse the current LUT, and whole-image TIFF export is not exposed.
- The static production build contains custom LibRaw WASM, Rust core WASM, and all hash-verified creative LUTs.
- The parity harness requires native and WASM LibRaw to decode the deterministic DNG to exactly the same RGB16 dimensions and samples.
- CLI integration covers readable RGB16 TIFF output, JSON-without-ANSI, forced and suppressed text color, corrupt input, and destination write failure without a false output.
- Playwright exercises an embedded camera JPEG, same-origin-only network activity, real browser RAW decode, positive slider and directly typed negative EV plus LUT rerender without re-decode, optimized native/WASM final TIFF equivalence within one code value for all 27 LUTs, decoded and state-isolated batch ZIP contents, recoverable corrupt-file failure, and the mobile empty-state task order.
- Layout and critique audits leave no unresolved detector or human-review findings.
