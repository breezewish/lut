# Processing End-to-End Tests

- A deterministic DNG decodes to exactly the RGB16 array frozen by Raw Alchemy's pinned Python environment.
- Legacy EV, Boost, gamut, V-Log, and LUT stages match their frozen checkpoints within their explicit local tolerances, and final uint16 differs by at most one code value.
- Corrected V-Log preserves negative values and is continuous at the official breakpoint.
- A strict CUBE parser validates axis order, domain, finite values, sample count, and all six tetrahedral branches.
- Corrected preview applies EV to both Base and LUT views while preserving the requested aspect ratio.
- TIFF export produces a readable Deflate-compressed RGB16 image with the requested dimensions.
