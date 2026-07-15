# Processing End-to-End Tests

- A deterministic DNG decodes to exactly the RGB16 array frozen by Raw Alchemy's pinned Python environment.
- Legacy EV, Boost, gamut, and V-Log stages match their frozen checkpoints; all 27 supported LUTs match separate Python export and preview baselines, with final RGB16 and preview RGBA8 differing by at most one code value.
- Corrected V-Log preserves negative values and is continuous at the official breakpoint.
- The corrected D65 matrix preserves neutral values and maps unit primaries and HDR input to the frozen coefficients.
- A strict CUBE parser validates axis order, domain, scientific notation, finite values, sample count, tetrahedron boundaries, and all six tetrahedral branches.
- Corrected preview applies EV, including both supported boundaries, to both Base and LUT views while preserving the requested aspect ratio.
- TIFF export produces a readable Deflate-compressed RGB16 image with the requested dimensions.
- A multi-strip TIFF render visits contiguous source ranges, bounds each quantized strip to approximately 1 MB, and produces independently decodable Deflate strips.
