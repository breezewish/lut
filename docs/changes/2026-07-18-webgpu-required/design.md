# Required WebGPU Design

## Runtime

The product Worker has one Preview path and one color path. A shared WebGPU
runtime records device loss and rejects later work with a reload instruction.
GPU resource construction destroys every buffer created before a failure.

LibRaw exposes one preflight predicate after unpack. The predicate accepts only
the geometry and metadata supported by tiled AAHD. Accepted RAWs expose the
sensor mosaic to GPU AAHD. Other supported RAWs complete LibRaw image
processing and stream bounded RGB16 views through the same GPU color renderer.

Benchmark stage capture and parity diagnostics live in a separately bundled
test Worker. Production builds compile that entry out. ONNX Runtime, its models,
and the abandoned native RCD backend are absent.

## Verification

Software WebGPU covers portable browser behavior. Main-branch publication is
gated by the production browser suite and the tiled AAHD correctness suite on
Chromium's SwiftShader WebGPU implementation. The latter compares tiled and
full-frame output exactly across CFA phases, tile seams, edge shapes, and
unequal black levels. CI has no cloud-provider credentials or external runner
trust relationship.

Software WebGPU is a deterministic correctness gate, not evidence of hardware
performance or driver compatibility. Hardware performance measurements and
camera-matrix validation remain explicit, manually invoked checks. Intel, AMD,
NVIDIA, and Apple hardware must be measured independently before making claims
about those devices.
