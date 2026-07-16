# RAW Decode Performance Tests

- The opt-in Chromium benchmark selects the 6240 × 4168 Sony RAW through the production page, records cold and warm processed-preview wall time, exports through the real Worker and download path, and writes every phased timing plus Blob size to JSON.
- The LibRaw algorithm benchmark decodes the same Sony RAW with AHD, DCB, and AAHD under identical parameters, discards warm-ups, reports phase distributions, records sampled pairwise RGB16 differences without labeling them ground-truth quality, and records the coordinates used for optional 1:1 quality crops.
- The Studio benchmark invokes the real Studio decode entry point for Bayer RCD and X-Trans Markesteijn, records the actual ONNX provider and fallback path, and separates demosaic from full decode time.
- The standard native/WASM parity check proves that phase callbacks and the split TIFF strip API do not change current AAHD RGB16 output.
- The strip unit tests prove that source reads remain bounded and color rendering and Deflate consume each strip exactly once.
