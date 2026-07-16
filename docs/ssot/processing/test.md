# Processing End-to-End Tests

- A deterministic DNG decodes to exactly the RGB16 array frozen by Raw Alchemy's pinned Python environment.
- Legacy EV, Boost, gamut, and V-Log stages match their frozen checkpoints; all 27 supported LUTs match separate Python export and preview baselines, with final RGB16 and preview RGBA8 differing by at most one code value.
- Corrected V-Log preserves negative values and is continuous at the official breakpoint.
- An independent standard-library Python float64 oracle checks corrected-v2 Base and LUT RGBA8, RGB16, and decoded TIFF samples and tags without importing production code or constants.
- The corrected D65 matrix preserves neutral values and maps unit primaries and HDR input to the frozen coefficients.
- Frozen non-clipped pixels decoded by pinned LibRaw directly to linear sRGB match the corrected transform from its ProPhoto D65 output within two code values.
- A strict CUBE parser validates axis order, domain, scientific notation, finite values, sample count, and a non-affine LUT's distinct outputs for all six tetrahedral branches and their shared boundaries.
- Corrected preview applies EV, including both supported boundaries, to both Base and LUT views while preserving the requested aspect ratio.
- The browser preview source requests only contributing decoded rows, retains exactly the pixels used at the requested display size, and rejects incomplete or inconsistent rows.
- TIFF export produces a readable horizontal-predicted, Deflate-compressed RGB16 image with the requested dimensions.
- A multi-strip TIFF render visits contiguous source ranges, bounds each quantized strip to approximately 1 MB, and produces independently decodable horizontal-predicted Deflate strips.
- The browser export adapter reads contiguous source views of at most approximately 1 MB into the stateful color-WASM encoder and rejects inconsistent strip contracts.
- The browser export adapter processes a 6240 × 4168 source while keeping every requested source view at or below approximately 1 MB.
- The production WASM binding gate proves the LibRaw wrapper exposes bounded zero-copy RGB16 views instead of a whole-image JavaScript copy, verified LUT bytes use ordered scalar words instead of a bulk byte binding, preview and export are created from the cached Rust parse result, preview creation accepts no RGB16 image, row ingestion is the only preview pixel boundary, EV rerenders accept neither RGB16 nor CUBE data, active-file removal frees the preview renderer, and no whole-image TIFF render function exists.
- The native/WASM decoder parity harness covers deterministic linear DNG, lossy JPEG DNG, real Leica CFA DNG, and full-resolution Sony ARW in full-size and half-size modes; every fixture proves separated RGB16 slices share the same WASM memory, out-of-bounds views fail, and complete dimensions and samples match exactly.
- The RAW fixture manifest verifies hashes, provenance, license, dimensions, and distinct roles for synthetic LinearRaw, real camera CFA DNG, and real camera ARW inputs.
- A C client compiles against the public header, links the produced computation library, verifies the stable V-Log and status symbols, renders corrected-v2 TIFF bytes, and releases the owned buffer through the paired ABI function.
