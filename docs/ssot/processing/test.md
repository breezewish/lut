# Processing End-to-End Tests

- A deterministic DNG decodes to exactly the RGB16 array frozen by Raw Alchemy's pinned Python environment.
- Legacy EV, Boost, gamut, and V-Log stages match their frozen checkpoints; all 27 supported LUTs match separate Python export and preview baselines, with final RGB16 and preview RGBA8 differing by at most one code value.
- Corrected V-Log preserves negative values and is continuous at the official breakpoint.
- The corrected D65 matrix preserves neutral values and maps unit primaries and HDR input to the frozen coefficients.
- Frozen non-clipped pixels decoded by pinned LibRaw directly to linear sRGB match the corrected transform from its ProPhoto D65 output within two code values.
- A strict CUBE parser validates axis order, domain, scientific notation, finite values, sample count, tetrahedron boundaries, and all six tetrahedral branches.
- Corrected preview applies EV, including both supported boundaries, to both Base and LUT views while preserving the requested aspect ratio.
- The browser preview source requests only contributing decoded rows, retains exactly the pixels used at the requested display size, and rejects incomplete or inconsistent rows.
- TIFF export produces a readable Deflate-compressed RGB16 image with the requested dimensions.
- A multi-strip TIFF render visits contiguous source ranges, bounds each quantized strip to approximately 1 MB, and produces independently decodable Deflate strips.
- The browser export adapter reads contiguous source views of at most approximately 1 MB into the stateful color-WASM encoder and rejects inconsistent strip contracts.
- The production WASM binding gate proves the LibRaw wrapper exposes bounded zero-copy RGB16 views instead of a whole-image JavaScript copy, the preview constructor accepts no RGB16 image, row ingestion is the only preview pixel boundary, EV rerenders accept neither RGB16 nor CUBE data, and no whole-image TIFF render function exists.
- The native/WASM decoder parity harness proves separated LibRaw RGB16 slices share the same WASM memory, out-of-bounds views fail, and the complete decoded image matches native dimensions and samples exactly.
