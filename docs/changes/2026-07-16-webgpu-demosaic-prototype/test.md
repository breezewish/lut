# ONNX-WebGPU Demosaic Prototype Tests

- The LibRaw sensor test validates Bayer and X-Trans dimensions, complete mosaic checksums, selected samples, CFA, effective black levels, white level, white balance, camera matrix, zero-copy views, and unpack phase timings.
- The demosaic unit tests validate Studio's Sony camera-to-ProPhoto matrix, reject unsupported four-color cameras, validate X-Trans mask partitions, and validate the Fujifilm canonical phase offset.
- The opt-in browser benchmark rejects software adapters, records sensor extraction and GPU stages, and supports cold plus warm hardware runs without correctness-reference overhead.
- The optional benchmark reference input compares every final RGB16 channel against a Studio native ONNX output and reports differing samples, threshold counts, maximum difference, its flat index, and mean absolute difference.
- The production build verifies that the Worker, custom WGSL shaders, unmodified Studio ONNX models, ONNX Runtime Web, LibRaw WASM, and application bundle package together.
