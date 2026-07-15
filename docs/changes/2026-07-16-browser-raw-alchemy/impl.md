# Browser RAW Alchemy Implementation

## Boundaries

- Rust computation: `crates/alchemy-core`.
- Native decode: `crates/alchemy-libraw`.
- Native product adapter: `crates/alchemy-cli`.
- Browser worker: `web/src/workers/processing.worker.ts`.
- Browser UI: `web/src/App.tsx` and `web/src/styles.css`.
- LUT source contract: `assets/luts.json`.
- Reproducible migration evidence: `baselines/legacy-python-v1`.

## Verification

Run the commands in root `README.md`. CI repeats all required checks from initialized submodules on Linux. The implementation document can be removed after the change has shipped and the SSOT documents are established.
