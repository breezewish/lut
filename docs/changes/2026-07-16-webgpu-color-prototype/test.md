# WebGPU Color Prototype Tests

- The WebGPU strip unit test proves that GPU RGB16 output is written without CPU color processing and that per-sample CPU differences are aggregated explicitly.
- The production build proves that the WGSL shader, WebGPU orchestration, Rust LUT export, LibRaw WASM, and TIFF WASM package together.
- The opt-in hardware benchmark records the selected adapter and rejects interpreting an unavailable adapter as a hardware result.
- The full-resolution correctness run compares every GPU RGB16 sample with the Rust CPU reference and reports maximum and mean absolute code-value differences.
- Separate CPU and WebGPU benchmark runs process the same Sony RAW through the production Worker and download path and record cold plus warm stage timings.
