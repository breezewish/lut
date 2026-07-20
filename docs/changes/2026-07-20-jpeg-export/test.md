# TIFF and JPEG Export Tests

- Output defaults to `TIFF · 16-bit` and selecting `JPEG · Quality 95` from the split button menu updates the main action.
- The processing client sends the selected output format and returns format-neutral encoded bytes.
- A production full-resolution JPEG download uses `.jpg`, decodes at the source dimensions, carries quality-95 quantization tables, and reports JPEG completion.
- Existing single and batch TIFF exports preserve their filenames, MIME types, RGB16 parity, failure handling, stop behavior, and ZIP isolation.
