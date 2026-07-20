# Portable WebGPU Coverage

## Introduction

Default CI verifies every portable correctness boundary needed to select and
run GPU RAW processing. Full-resolution camera and driver evidence remains a
separate hardware concern.

## Background

The hardware camera matrix covers seven large RAW files, including a Nikon Z 6
NEF. A complete 24-megapixel AAHD export did not finish on SwiftShader after a
12-minute test timeout, so running the hardware matrix unchanged in portable CI
would violate the repository's test-time budget.

The previous portable gate validated synthetic tiled AAHD math but did not
cross a real RAW decoder-to-production-export boundary. The normal browser
suite exercised WebGPU color with inputs that did not require GPU demosaic. A
minimum valid 516 × 516 production X-Trans export also exceeded a five-minute
SwiftShader timeout.

## Goals and Non-goals

The design must verify the Nikon NEF decoder and routing contract on every CI
run, verify both GPU demosaic routing contracts, and execute a complete
production WebGPU AAHD export on SwiftShader. It must keep the portable gate
bounded and deterministic.

The design does not treat SwiftShader as evidence of hardware speed, driver
compatibility, or full-resolution camera output parity.

## Detailed Design

The fixture preparer accepts manifest IDs. Default CI prepares only the pinned
Nikon Z 6 NEF and caches the ignored download by manifest hash. The LibRaw
sensor harness verifies exact regular/pthread mosaic parity, fixed metadata and
samples, Preview-retained mosaic parity, and strict WebGPU AAHD selection.

A generated 1024 × 1024 packed Bayer DNG crosses the production page, Worker,
LibRaw sensor extraction, tiled WebGPU AAHD, corrected-v2 color, TIFF encoder,
and browser download. Its TIFF is compared with the independent native CLI
output. The existing six-code SwiftShader ceiling applies.

A generated 516 × 516 6 × 6 CFA DNG verifies exact regular/pthread LibRaw
sensor parity and strict WebGPU X-Trans selection. The production X-Trans
shader remains in the hardware suite because its minimum valid workload cannot
meet the portable CI budget.

One hardware command prepares the complete camera matrix and enables every
full-resolution camera, AAHD, X-Trans, fallback-geometry, auto-white-balance,
and Preview case on a non-fallback adapter. Performance benchmarks remain
separate commands.

## Trade-offs

The portable gate factors format decoding from GPU demosaic instead of running
the full Nikon image or minimum X-Trans tile through software rasterization.
This loses full-image NEF and X-Trans shader parity evidence in default CI,
which the hardware suite retains. In exchange, decoding and routing are gated
without a multi-minute duplicate of the hardware workload.

Downloading one 30 MB checksum-pinned fixture adds an external dependency to a
cold CI run. Atomic retries, exact length and SHA-256 validation, and the
manifest-keyed cache bound that risk.

## Test Plan

Run the sensor harness with the Nikon and generated X-Trans fixtures, the
bounded production export on SwiftShader, the complete portable WebGPU suite,
and the normal browser suite. Run the full hardware command on a non-fallback
adapter when hardware evidence is required.

## Open Questions

None.

## Appendix

Historical GitHub Actions runs showed the 6240 × 4168 Sony AAHD export timing
out first at five minutes and then at twelve minutes on SwiftShader. The
bounded production export completes in seconds on the same software backend.
