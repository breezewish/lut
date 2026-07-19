# WebGPU X-Trans Export

## Introduction

Standard Fujifilm X-Trans export runs LibRaw-compatible demosaic on WebGPU instead of spending tens of seconds in single-threaded browser WASM.

## Goals and non-goals

The implementation preserves LibRaw's full-resolution RGB16 result with bounded GPU resources and streamed TIFF output. It covers standard unrotated three-color X-Trans sensors. Preview keeps its existing display-sized LibRaw path because it is a different latency and quality contract. Legacy diagonal Fuji geometry and unusual RAW layouts remain outside the GPU contract.

## Detailed design

LibRaw identifies and unpacks the active mosaic and supplies adjusted black levels, white balance multipliers, the 6×6 CFA, CIELab matrix, ProPhoto matrix, and exact CIELab lookup table. WebGPU scales the mosaic once and evaluates LibRaw's three-pass, eight-direction Markesteijn algorithm in 512px tiles.

Tiles preserve LibRaw's eight-pixel scan-order overlap. The overlap contains the intermediate image state, including the six- and seven-pixel edge rows that exist before final border interpolation. Homogeneity buffers clear the uncomputed edge cells on every tile. CIELab arithmetic uses storage boundaries wherever WGSL contraction could change a direction threshold.

The selected camera RGB runs Blend highlight reconstruction and ProPhoto conversion on GPU, enters the existing corrected-v2 color renderer, and streams through two readback buffers into the TIFF encoder. The largest single buffer stays below 49 MB and verified peak allocation stays below 179 MB.

## Trade-offs

Explicit floating-point storage boundaries add dispatches and one 32 MB scratch buffer. They are required for stable cross-camera direction selection. A faster contracted variant is not acceptable because sparse threshold changes produce large local RGB errors.

Preview does not run full-resolution Markesteijn. Measured X-T2 preview latency is dominated by roughly 1.9 seconds of compressed sensor unpacking; the existing display-sized LibRaw work is only a few hundred milliseconds and avoids the full export workspace.

## Test plan

The hardware suite compares camera RGB exactly against captured LibRaw output for X-T1 and X-T2. End-to-end TIFF tests compare both cameras with independent native exports, require no sample to differ by more than two codes, and exercise a nonempty X-T1 highlight set. The existing Nikon, Panasonic, and Bayer Fujifilm matrix guards routing regressions.

## Open issues

None.

## Appendix: T4 validation

Measurements used a g4dn.xlarge with an NVIDIA T4 and the production Chromium path. For the 6032×4028 lossless-compressed X-T2 fixture, export wall time fell from 38.70 s to 5.04 s (7.68×), and Worker time fell from 37.70 s to 4.06 s (9.27×). The WebGPU X-Trans stage took 1.70 s and peak tracked GPU allocation was 170.1 MiB.

X-T1 and X-T2 matched LibRaw for every camera RGB16 sample before highlight reconstruction and color conversion. Final production TIFF output differed from the native reference by at most one RGB16 code on both cameras, within the two-code contract. The X-T1 run covered 355 highlighted pixels.

Cold X-T2 processed-preview time changed from 2.82 s to 2.88 s, which is not a material improvement. The preview route therefore remains unchanged; compressed RAW unpacking accounted for roughly 1.9 s in both versions.
