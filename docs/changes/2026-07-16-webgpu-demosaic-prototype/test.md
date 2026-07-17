# Native WebGPU RAW Pipeline Prototype Tests

- The LibRaw sensor test validates Bayer and X-Trans dimensions, complete mosaic checksums, selected samples, CFA, effective black levels, white level, white balance, camera matrix, zero-copy views, and unpack phase timings.
- The demosaic unit tests validate Studio's Sony camera-to-ProPhoto matrix, reject unsupported four-color cameras, validate X-Trans mask partitions, and validate the Fujifilm canonical phase offset.
- The native support test validates the red-fastest sample order required by tetrahedral 3D LUT lookup.
- The opt-in hardware benchmark rejects software adapters and separately records sensor extraction, upload, black normalization, RCD, fused color/LUT/RGB16, RGB16 readback, reference validation, Deflate, and Blob time.
- The optional full-frame reference compares every final RGB16 channel against Studio native output and reports differing samples, one-code and eight-code thresholds, maximum error and location, mean absolute error, RMS error, and PSNR.
- The complete-export benchmark creates a readable full-resolution TIFF through the real WASM horizontal-predictor and Deflate encoder and records its byte size.
- The production build verifies that the Worker, handwritten WGSL, retained ONNX controls, LibRaw WASM, color/TIFF WASM, and application bundle package together.
- The normal browser end-to-end suite continues to verify the unchanged production AAHD path; the prototype backend is opt-in and does not silently change product output.
