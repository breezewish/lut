# WebGPU Preview Design

## Runtime

The Preview-only LibRaw path still produces one orientation-correct longest-edge-1024 ProPhoto RGB16 source. Rust performs bounded source-row selection, then moves that completed allocation once to the Worker. The Worker packs it into one persistent WebGPU storage buffer and releases both the Rust source and LibRaw instance.

One compute shader performs nearest display sampling, exposure, corrected-v2 Base conversion, V-Log conversion, tetrahedral LUT interpolation, and RGBA8 quantization. The source, current LUT, two output buffers, two readbacks, and uniforms remain allocated across rerenders. The worst square 1024px workspace is below 26 MB, excluding the shared WebGPU device. Device and shader initialization starts when the Worker loads so cold GPU setup overlaps file selection and LibRaw work.

The Worker serializes GPU submissions. `ProcessingClient` keeps one render active and only the latest waiting recipe. WebGPU exposure commits are limited to one per 16 ms and render at 1024px immediately. There is no CPU fallback or delayed refinement.

## Correctness

Native corrected-v2 exports and pinned display-quality fixtures are the independent correctness references. Production does not retain a second source or run CPU/GPU validation.

## Trade-offs

The browser still reads RGBA8 back to Canvas because the current presentation and accessibility model uses 2D canvases and React-owned frames. Keeping the source and color work on the GPU removes the dominant CPU loop without introducing a second rendering architecture. Direct GPU canvas presentation is deferred because it would duplicate comparison, responsive layout, and 1:1 panning behavior for a smaller remaining gain.
