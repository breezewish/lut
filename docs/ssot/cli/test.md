# CLI End-to-End Tests

- A real lossy DNG exports to a readable 256×168 RGB16 TIFF and reports corrected-v2 plus the pinned LibRaw version in JSON.
- A corrupt RAW exits nonzero, emits structured JSON error output, and creates no destination file.
