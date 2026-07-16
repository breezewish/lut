# CLI End-to-End Tests

- A real lossy DNG exports to a readable 256×168 RGB16 TIFF and reports corrected-v2 plus the pinned LibRaw version in JSON.
- JSON output contains no ANSI even when color is forced; successful and failed text output include ANSI only when requested.
- A corrupt RAW exits nonzero, emits structured JSON error output, and creates no destination file.
- A valid conversion whose destination cannot be written exits nonzero, emits a structured write error, and creates no destination file.
