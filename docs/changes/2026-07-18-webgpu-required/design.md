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
unequal black levels. A bounded packed Bayer DNG additionally crosses the real
production Worker, WebGPU AAHD, color, TIFF, and download boundaries. CI also
downloads the checksum-pinned Nikon Z 6 NEF and verifies its LibRaw sensor
output, metadata, retained mosaic, and AAHD route without attempting its slow
full-resolution software demosaic. A generated 6 × 6 CFA DNG verifies the
X-Trans sensor and route boundary; even its minimum valid 516 × 516 production
shader workload exceeds the portable five-minute budget. CI has no
cloud-provider credentials or external runner trust relationship.

Software WebGPU is a deterministic correctness gate, not evidence of hardware
performance or driver compatibility. Full-resolution camera-matrix validation
and hardware performance measurements remain one explicit, manually invoked
non-fallback suite. Intel, AMD, NVIDIA, and Apple hardware must be measured
independently before making claims about those devices.
