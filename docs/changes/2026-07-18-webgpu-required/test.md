# Required WebGPU Tests

- Product commands expose no backend-selection or CPU/GPU validation fields.
- Missing WebGPU and lost devices fail with explicit compatibility and reload errors.
- Partial Preview and Export allocations release already-created buffers.
- Linear DNG exports through LibRaw demosaic and WebGPU color and matches native output.
- Bayer Sony and Leica exports use WebGPU AAHD and every cold and warm TIFF stays within two RGB16 codes of native output.
- A Leica DNG without camera white balance matches LibRaw auto white balance.
- The pinned X-Trans Fujifilm RAW uses LibRaw demosaic plus WebGPU color and matches native output.
- The production bundle contains no benchmark entry, ONNX Runtime, ONNX model, or native RCD asset.
- Pages deployment waits for production browser tests and exact tiled AAHD correctness checks on SwiftShader WebGPU.
