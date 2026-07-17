# ONNX Color Prototype

## Introduction

This change tests whether one standard ONNX graph can replace the browser's
handwritten WebGPU export color kernel and later be shared with a native CLI.
The graph is correct and runs entirely through the WebGPU Execution Provider,
but it is not recommended for the color and 3D LUT stage.

After batching independently from TIFF compression, ONNX reduces the CPU color
stage from 5.03 s to 2.89 s. The fused WGSL implementation takes 0.77 s. ONNX
therefore makes the complete export 11.2% slower than WGSL and adds a 24.3 MB
runtime artifact, 6.0 MB after gzip.

ONNX remains a candidate for a shared demosaic implementation. That is a
separate decision because demosaic graphs have different operators, compute
intensity, and maintenance costs.

## Background

The browser and native CLI currently share the Rust CPU color pipeline. The
WebGPU prototype accelerates browser export with one WGSL kernel, but a future
native GPU implementation would need another integration. ONNX Runtime offers
a shared model contract with WebGPU in the browser and native execution
providers such as CPU and CUDA in the CLI.

The relevant color recipe is:

1. Normalize RGB16 and apply exposure.
2. Convert ProPhoto D65 to V-Gamut with a fixed matrix.
3. Encode V-Log.
4. Apply a CUBE LUT with tetrahedral interpolation.
5. Clamp and round to RGB16.

## Goals and Non-goals

### Goals

- Express the complete export color recipe as standard ONNX operators.
- Preserve the existing tetrahedral tie rules and RGB16 rounding contract.
- Prove whether ONNX Runtime Web executes the graph on hardware WebGPU.
- Compare CPU, fused WGSL, and ONNX on the same RAW, browser, and GPU.
- Measure runtime size and CPU/GPU tensor-boundary costs.

### Non-goals

- Make ONNX a production backend.
- Add ONNX Runtime to the native CLI.
- Change RAW decode, TIFF compression, or the creative look contract.
- Use a custom ONNX operator that would require platform-specific kernels.

## Detailed Design

The experiment adds an explicit `colorBackend=onnx` export backend. It has no
fallback. Rust remains the CUBE parser and TIFF writer.

The generated opset 18 model has dynamic pixel and LUT dimensions. It uses only
standard arithmetic, comparison, selection, matrix multiplication, gather, and
shape operators. Six tetrahedral regions reproduce the existing ordered
comparisons, including equal-component tie behavior.

ONNX Runtime Web 1.27 executes the model with the WebGPU Execution Provider.
RGB16 samples are converted to Float32 before inference. The ONNX output is an
integer-valued Float32 tensor and is converted to RGB16 before TIFF compression.
This Float32 boundary is required: a UINT16 input/output model fails session
creation because its Cast node cannot be assigned to an execution provider.

ONNX inference batches up to 4,000,000 channel samples independently from the
approximately 1 MB TIFF compression strips. Rendered batches are split back
into the original strips before Deflate. This reduces graph invocations from
about 155 to about 20 for the measured 26 MP image without changing TIFF memory
or output semantics.

Validation mode renders the same source through the Rust CPU reference and
compares every RGB16 channel sample. Any difference above two code values fails
immediately.

## Tradeoffs

### Shared graph versus fused execution

The ONNX model is a portable algorithm asset, but standard operators do not
preserve the fusion available to a purpose-built image kernel. The 89-node
model produced 27 distinct WGSL shader programs after ONNX Runtime graph
optimization. The fused implementation uses one shader program and one compute
dispatch per batch.

The ONNX graph also requires Float32 host tensors. Input and output preparation
alone take a warm median of 1.22 s, which is greater than the complete fused
WGSL color stage.

### Portability versus runtime cost

The same ONNX model could be loaded by a native CLI. The application would
still need separate browser and native runtime adapters, provider packaging,
buffer ownership, and conformance tests. The browser build gains a 24.3 MB
ONNX Runtime WASM artifact, 6.0 MB after gzip, before adding any demosaic model.

### Standard graph versus custom operator

A custom tetrahedral LUT operator could fuse the graph, but it would require a
WebGPU implementation and native implementations for each CLI provider. That
restores the platform code split the ONNX experiment is intended to remove.

## Recommendation

Do not move the color matrix, V-Log, tetrahedral LUT, or RGB16 quantization to a
standard ONNX graph. Keep the fused GPU color kernel and share its behavior
through explicit constants, conformance vectors, and an RGB16 tolerance
contract.

Evaluate ONNX separately for RCD and Markesteijn demosaic. A complex demosaic
graph may justify the runtime and portability tradeoff, but its browser and
native provider performance must be measured before adoption. If ONNX is
introduced for demosaic, transfer its RGB result directly into the fused color
kernel where possible instead of representing the complete export pipeline as
many standard ONNX operators.

## Test Plan

- Validate the ONNX graph against the Rust CPU reference for every RGB16 sample
  in a real full-resolution RAW export.
- Record one cold and four warm CPU, WGSL, and ONNX exports on the same T4.
- Verify the WebGPU adapter is hardware and not a fallback adapter.
- Use verbose provider diagnostics on a small RAW to verify WebGPU shader
  generation and the absence of CPU fallback warnings.
- Verify that ONNX batches span multiple TIFF strips without changing strip
  boundaries or validation behavior.
- Run browser unit tests, TypeScript compilation, and the production build.

## Open Questions

- Whether a future ONNX Runtime release can fuse the relevant elementwise,
  branch, and gather subgraphs into materially fewer WebGPU programs.
- Whether ONNX demosaic output can remain GPU-resident and be consumed by the
  fused color kernel without a host readback.

## Appendix A: Hardware and Input

- Instance: AWS `g4dn.xlarge`
- GPU: NVIDIA Tesla T4, 15 GB, Turing
- Driver: 595.71.05
- Browser: Chrome for Testing 149.0.7827.55
- ONNX Runtime Web: 1.27.0
- RAW: Sony ARW, 6240 x 4168, 31,793,152 bytes
- Measurement: one cold run followed by four warm runs
- Adapter: NVIDIA Turing, `isFallbackAdapter=false`

## Appendix B: Warm Performance

| Stage            |     CPU | Fused WGSL | Batched ONNX |
| ---------------- | ------: | ---------: | -----------: |
| Full export wall | 22.49 s |    18.66 s |      20.74 s |
| Worker total     | 21.61 s |    17.78 s |      19.86 s |
| LibRaw           |  9.77 s |    10.11 s |      10.10 s |
| Color and LUT    |  5.03 s |     0.77 s |       2.89 s |
| Deflate          |  6.58 s |     6.82 s |       6.78 s |

ONNX is 1.74 times faster than CPU for color processing, but 3.76 times slower
than fused WGSL. At the complete-export boundary, ONNX is 7.8% faster than CPU
and 11.2% slower than WGSL.

The batched ONNX color median consists of:

| ONNX boundary                       | Median |
| ----------------------------------- | -----: |
| RGB16 to Float32 input preparation  | 0.44 s |
| Graph execution and readback        | 1.68 s |
| Float32 to RGB16 output preparation | 0.78 s |

## Appendix C: Correctness

The full-resolution validation compared 78,024,960 RGB16 channel samples:

| Metric                                  |        Result |
| --------------------------------------- | ------------: |
| Exact samples                           |      99.9307% |
| Samples differing by one code           |        54,088 |
| Samples differing by more than one code |             0 |
| Maximum absolute difference             |        1 code |
| Mean absolute difference                | 0.000693 code |

## Appendix D: Provider Diagnosis

Verbose ONNX Runtime diagnostics created an NVIDIA WebGPU context and generated
27 distinct WGSL shader programs for the optimized graph. No CPU fallback,
unassigned-node, or CPU-execution warning was emitted. The performance gap is
therefore caused by graph granularity, intermediate tensors, and Float32 host
boundaries rather than software adapter fallback.
