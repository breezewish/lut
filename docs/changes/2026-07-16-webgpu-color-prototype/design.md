# WebGPU Color Prototype

## Introduction

This change prototypes WebGPU for the browser export color stage and measures
it against the existing Rust/WASM implementation. LibRaw decode, TIFF layout,
Deflate, Blob creation, and the CLI remain unchanged. The prototype is not a
production backend decision.

The measured result supports further productization: on an NVIDIA T4, WebGPU
reduced full-resolution color processing from 5.15 s to 0.72 s and reduced
warm export wall time from 22.44 s to 18.06 s. Every one of the 78,024,960
RGB16 samples was compared with the CPU reference. The maximum difference was
one code value.

## Background

The production browser currently decodes linear ProPhoto RGB16 in LibRaw and
passes bounded strips into Rust/WASM. Rust applies exposure, the fixed
ProPhoto-to-V-Gamut matrix, V-Log, tetrahedral 3D LUT interpolation, and RGB16
quantization before Deflate-compressing each TIFF strip.

The existing diagnosis measured this color stage at about 5.1 s for the 6240 ×
4168 Sony fixture. Its operations are independent per pixel, making it a much
better GPU target than LibRaw's branch-heavy AAHD implementation or Deflate's
serial match and bitstream work.

## Goals and Non-goals

Goals:

- Run the existing corrected-v2 export color recipe in a WebGPU compute shader.
- Preserve the bounded-strip memory model and existing TIFF/Deflate path.
- Compare every GPU RGB16 sample with the Rust CPU reference.
- Measure GPU upload, compute plus readback, color wall time, Worker time, and
  export wall time on the same browser and RAW.
- Record the selected adapter so software GPU fallback cannot be mistaken for
  hardware acceleration.

Non-goals:

- Change preview rendering, demosaic, Deflate, Blob construction, or CLI output.
- Make WebGPU the production default.
- Add a silent CPU fallback when WebGPU is unavailable.
- Claim cross-browser or cross-GPU readiness from one NVIDIA fixture.

## Detailed Design

The browser Worker selects the prototype through an explicit benchmark query
parameter. The default remains the CPU implementation.

Rust remains the strict CUBE parser. The parsed LUT exposes its edge size,
domain, and RGB-interleaved f32 samples to the Worker for one GPU upload per
export. A persistent compute pipeline applies the corrected-v2 color recipe.
Two RGB pixels are packed into three `u32` words, preserving the existing
interleaved RGB16 byte layout without expanding each sample to 32 bits.

Each approximately 1 MB LibRaw view is uploaded to a storage buffer. The shader
applies exposure, the fixed 3 × 3 matrix, V-Log, manual tetrahedral lookup, and
round-to-nearest RGB16 quantization. The packed output is copied to a mapped
readback buffer and passed directly to the existing Rust TIFF writer. Deflate
therefore consumes the same strip shape and RGB16 representation in both
backends.

Validation mode also renders the source strip on the CPU. It compares every
sample before writing the GPU strip and accumulates differing samples, samples
over two codes, maximum absolute difference, and mean absolute difference.
The run fails immediately if any sample differs by more than two codes.

The CLI retains the portable Rust CPU implementation. A native GPU backend is
not required because the browser upload/readback boundary and browser runtime
are the performance question under test.

## Tradeoffs

Direct WebGPU orchestration in TypeScript keeps the existing Worker in control
and avoids adding `wgpu` to the browser WASM. WGSL is the compute source that
would matter for any future native GPU reuse.

The prototype allocates strip buffers per dispatch and waits for readback
before starting the next strip. This is intentionally simple and includes all
real transfer costs. Persistent double-buffered strips may improve throughput,
but are not needed to establish material benefit.

GPU arithmetic is not bit-identical to Rust f32 arithmetic. The output contract
for this experiment permits at most two RGB16 code values of absolute error
and reports the full distribution instead of hiding it. The observed maximum
was one code value.

WebGPU remains an explicit backend. Production adoption must decide whether
hardware WebGPU is a requirement or a user-visible option; it must not silently
change backend and output according to browser availability.

## Test Plan

- Run Rust and browser unit tests, including bounded GPU strip writing and
  validation aggregation.
- Build the production page, LibRaw WASM, and color WASM.
- Run one full 26 MP export with GPU and CPU color enabled together, comparing
  every RGB16 sample.
- Run one cold and four warm CPU exports.
- Run one cold and four warm WebGPU exports on the same instance and browser.
- Require a hardware adapter report with `isFallbackAdapter=false`.

## Open Questions

- Whether supported browsers and target consumer GPUs meet the same correctness
  and performance bounds.
- Whether the product should require WebGPU or expose CPU and GPU as explicit
  modes.
- Whether persistent double buffering materially improves the already
  sub-second color stage.
- Whether AHD passes the separate image-quality gate; WebGPU does not alter
  that decision.

## Appendix: Evidence

Environment:

- AWS `g4dn.xlarge`, NVIDIA Tesla T4 15 GB
- Ubuntu 22.04 Deep Learning Base OSS NVIDIA Driver GPU AMI
- NVIDIA driver 595.71.05, Vulkan 1.4
- Chrome for Testing 149.0.7827.55
- Browser adapter: vendor `nvidia`, architecture `turing`, fallback `false`
- RAW: `vendor/LibRaw-Wasm/example-sony.ARW`, 6240 × 4168, 31,793,152 bytes
- One cold run followed by four warm runs for each backend

Warm medians and observed ranges:

| Stage                  |            CPU median |             WebGPU median |                Change |
| ---------------------- | --------------------: | ------------------------: | --------------------: |
| Export wall            | 22.44 s (22.01–22.84) |     18.06 s (17.80–18.22) |                −19.5% |
| Worker total           | 21.56 s (21.13–21.97) |     17.18 s (16.91–17.34) |                −20.3% |
| LibRaw                 |   9.86 s (9.73–10.27) |       9.91 s (9.59–10.02) | effectively unchanged |
| Color/LUT              |    5.15 s (4.95–5.22) |        0.72 s (0.70–0.74) |         −86.1%, 7.18× |
| Deflate                |    6.54 s (6.32–6.62) |        6.48 s (6.44–6.55) | effectively unchanged |
| GPU upload             |                     — |    32.95 ms (32.10–36.90) |        included above |
| GPU compute + readback |                     — | 665.20 ms (651.00–682.30) |        included above |

Full-image correctness:

| Metric                                  |                Result |
| --------------------------------------- | --------------------: |
| Compared RGB16 samples                  |            78,024,960 |
| Exact samples                           | 77,973,599 (99.9342%) |
| Samples differing by one code           |      51,361 (0.0658%) |
| Samples differing by more than one code |                     0 |
| Maximum absolute difference             |                1 code |
| Mean absolute difference                |        0.000658 codes |

The result demonstrates a real end-to-end improvement, not merely shader
throughput. It also shows the remaining limit: after GPU color processing,
LibRaw and Deflate account for almost the entire export. The next independent
performance decisions remain the AHD quality gate and parallel Deflate.
