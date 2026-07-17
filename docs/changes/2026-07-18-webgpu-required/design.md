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
gated by an NVIDIA T4 job started through GitHub OIDC and AWS Systems Manager.
The job runs Preview, repeated Export, camera-matrix, white-balance, and native
CLI alignment tests, then stops the instance in an unconditional cleanup step.

The T4 is the current automated hardware baseline. Cross-vendor Intel, AMD, and
Apple hardware remains required before claiming those devices as verified; the
suite is portable and can be attached to additional runners without changing
product code.
