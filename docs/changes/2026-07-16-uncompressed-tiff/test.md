# Uncompressed TIFF Export Tests

- Core and corrected-v2 tests decode TIFF output, require compression code 1, and verify exact dimensions and RGB16 samples while strip buffers remain approximately 1 MB.
- Browser adapter tests keep every LibRaw source view bounded and report color processing and TIFF encoding separately.
- Full-resolution Sony browser output is an uncompressed 156,051,306-byte TIFF, completes TIFF encoding below 1 second on the benchmark host, and matches native corrected-v2 output within one code value.
- Browser single-file and pass-through batch ZIP journeys decode every uncompressed TIFF entry successfully.
- Native CLI and C callers produce readable uncompressed RGB16 TIFF output through the shared core.
