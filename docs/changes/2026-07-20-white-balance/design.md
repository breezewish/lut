# Relative White Balance Design

## Model

LibRaw first produces camera-As-Shot linear ProPhoto D65. LUTify applies one relative Bradford chromatic-adaptation matrix after exposure and before Base or V-Log/LUT color. Temperature shifts the 6504 K anchor by one mired per UI step. Tint shifts the Planckian locus by `-0.0005 Duv` per step, matching Raw Alchemy Studio.

The exact Studio Planckian locus over the supported interval is represented by fixed degree-10 polynomials. Matrix construction runs once per recipe. The browser uploads three aligned matrix rows as WebGPU uniforms; every pixel stays on GPU through Preview, Look thumbnails, tiled demosaic export, and bounded LibRaw export strips. Rust owns an independent native implementation for CLI, C API, and oracle comparisons.

Recipe identity contains file, EV, Temperature, Tint, and LUT. Base identity omits only the LUT. Look thumbnail caches contain the complete Base recipe. Exact settled-recipe equality remains the only export-readiness condition.

## Trade-offs

This is post-decode chromatic adaptation, not camera-native RAW multiplier reconstruction. It provides materially more latitude than correcting an already rendered TIFF while preserving the current single decoded source and GPU pipeline. Absolute Kelvin copy would overstate that model, so the UI uses understandable relative values and As Shot.
