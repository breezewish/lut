# CLI End-to-End Tests

- A real lossy DNG exports to a readable uncompressed 256×168 RGB16 TIFF and reports corrected-v2 plus the pinned LibRaw version in JSON, including when the Linux destination path is not valid UTF-8.
- Temperature and Tint use the same Studio-compatible relative white balance as browser export, and zero on both axes preserves the previous As Shot output.
- JSON output contains no ANSI even when color is forced; successful and failed text output include ANSI only when requested.
- A corrupt RAW exits nonzero, emits structured product-language JSON without LibRaw internals, and creates no destination file.
- A valid conversion whose destination cannot be written exits nonzero, emits a structured write error, and creates no destination file.
