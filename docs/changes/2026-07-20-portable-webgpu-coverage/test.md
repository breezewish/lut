# Portable WebGPU Coverage Tests

- Default CI downloads the pinned Nikon Z 6 NEF and verifies its exact LibRaw sensor mosaic, metadata, Preview-retained mosaic, and strict WebGPU AAHD route.
- Default CI generates a bounded 6 × 6 CFA DNG and verifies exact LibRaw sensor parity plus strict WebGPU X-Trans routing.
- A 1024 × 1024 packed Bayer DNG follows the complete production WebGPU AAHD, color, TIFF, and download path on SwiftShader and stays within six codes of the native CLI output.
- The portable tiled AAHD suite continues to match full-frame math exactly across CFA phases, tile seams, edge shapes, unequal black levels, and repeated workspaces.
- The explicit hardware suite runs every full-resolution camera-matrix, Sony, Leica, auto-white-balance, rotated-geometry, X-Trans, and Preview case on a non-fallback adapter.
