# ONNX Color Prototype Tests

- The model generator produces a valid opset 18 graph with dynamic pixel and LUT dimensions.
- The GPU batching unit test proves that one color inference can span multiple unchanged TIFF compression strips.
- The GPU validation unit test reports explicit per-sample differences and rejects any difference above two RGB16 codes.
- The production build packages the ONNX model, ONNX Runtime Web, Worker integration, LibRaw WASM, color WASM, and TIFF output.
- A full-resolution hardware validation compares every ONNX RGB16 channel sample with the Rust CPU reference.
- Separate CPU, fused WGSL, and batched ONNX runs record one cold and four warm exports of the same Sony RAW on the same T4.
- A verbose small-RAW diagnostic proves that ONNX Runtime creates the hardware WebGPU context and generates GPU shader programs without CPU fallback warnings.
- A UINT16 model diagnostic proves that ONNX Runtime Web rejects the required Cast boundary instead of silently falling back.
