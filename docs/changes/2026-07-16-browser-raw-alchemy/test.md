# Browser RAW Alchemy Change Tests

- The pinned Python environment regenerates the committed legacy checkpoint archive and manifest from hashed RAW and LUT inputs.
- Native debug and optimized Rust pass the complete workspace suite against legacy and corrected behavior.
- The static production build contains custom LibRaw WASM, Rust core WASM, and all hash-verified creative LUTs.
- The parity harness requires native and WASM LibRaw to decode the deterministic DNG to exactly the same RGB16 dimensions and samples.
- Playwright exercises real browser RAW decode, preview, native/WASM final TIFF equivalence within one code value, batch ZIP, recoverable corrupt-file failure, and the mobile empty-state task order.
- Layout and critique audits leave no unresolved detector or human-review findings.
