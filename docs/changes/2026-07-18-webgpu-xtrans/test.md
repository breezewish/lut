# WebGPU X-Trans Tests

- Fujifilm X-T1 and X-T2 GPU Markesteijn camera RGB matches the pinned LibRaw result for every RGB16 sample before highlight and color processing.
- Fujifilm X-T1 and X-T2 production TIFF exports stay within two RGB16 codes of independent native LibRaw exports on a non-fallback T4 adapter.
- The X-T1 fixture contains highlighted pixels so production GPU Blend reconstruction is covered by the end-to-end comparison.
- The SHA-256-pinned camera fixture script restores both ignored RAF files reliably.
- Nikon Z6 and Fujifilm X-A5 continue through GPU AAHD, while Panasonic GH5 continues through LibRaw demosaic and required WebGPU color.
- X-Trans tile geometry covers rectangular final tiles once and rejects invalid CFA patterns.
