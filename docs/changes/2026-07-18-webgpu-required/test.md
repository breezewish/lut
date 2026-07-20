# Required WebGPU Tests

- Product commands expose no backend-selection or CPU/GPU validation fields.
- Missing WebGPU and lost devices fail with explicit compatibility and reload errors.
- Partial Preview and Export allocations release already-created buffers.
- Linear DNG exports through LibRaw demosaic and WebGPU color and matches native output.
- Bayer Sony and Leica exports use WebGPU AAHD and every cold and warm TIFF stays within two RGB16 codes of native output.
- A Leica DNG without camera white balance matches LibRaw auto white balance.
- The pinned X-Trans Fujifilm RAW uses LibRaw demosaic plus WebGPU color and matches native output.
- The production bundle contains no benchmark entry, ONNX Runtime, ONNX model, or native RCD asset.
- Default CI verifies the checksum-pinned Nikon Z 6 NEF sensor output, metadata, retained mosaic, and strict WebGPU AAHD route.
- Default CI verifies a generated 6 × 6 CFA DNG sensor output and strict WebGPU X-Trans route.
- A bounded packed Bayer DNG follows the complete production WebGPU AAHD export path on SwiftShader and stays within the software six-code ceiling of native LibRaw.
- Pages deployment waits for production browser tests, the Nikon decoder boundary, and portable SwiftShader correctness checks.
