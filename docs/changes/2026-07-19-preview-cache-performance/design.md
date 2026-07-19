# Preview Cache Performance Design

## Introduction

The preview pipeline uses bounded reuse at both processing and presentation boundaries.

## Detailed Design

The Worker owns an LRU of six independent longest-edge-1024 RGB16 WebGPU sources. One preview renderer owns the current LUT and a shared Base output, Look output, and two readback buffers. Serialized render commands select a retained source by file identity before using this workspace. The workspace grows to the largest selected source and smaller sources reuse it without allocation. An activation command refreshes recency without rendering, and decode replaces only the matching file entry. Compressed strict WebGPU demosaic input may attach a sensor mosaic to an entry for export; mosaics share one 64 MiB budget and can be evicted without evicting the GPU source. Release frees one photo's source and mosaic; clear frees all sources, mosaics, and the shared renderer.

React retains three photos' settled comparison buffers. Look thumbnails use a separate three-photo cache keyed by file identity and EV. LUT identity is the tile key inside that cache because every tile represents one LUT. App startup conditionally revalidates the manifest and starts every hash-versioned LUT request concurrently through the browser HTTP cache. An EV change installs a new empty completion entry while leaving the previous tiles displayed. As soon as the main preview settles, one Worker command renders the selected LUT and then the missing 132px tiles in LUT-readiness order. The Worker converts each tile to `ImageBitmap`; the UI replaces only that tile in a low-priority transition. A main-preview command preempts the batch between LUTs, and a preempted batch resumes only its genuinely missing tiles. Switching to a retained recipe publishes its cached comparison synchronously before the Worker activation reply.

The uncontrolled exposure slider updates native presentation immediately. Pointer-down alone does not change Preview state. Dragging changes only a transient active-photo recipe; the selected photos' persistent EV updates at pointer release or after 80 ms without input, even when the pointer remains down. The render client keeps one active recipe and one newest waiting recipe, never resetting the pending value when an older EV completes. Slider frames use longest-edge 256 and arrive as Worker-created `ImageBitmap` objects so transient RGBA allocation and garbage collection never block the UI thread. LUT changes use the same progressive contract: a 256px Look bitmap followed by a cacheable 1024px Look bitmap while the Base pane remains unchanged. The exact 1024px frame alone restores export readiness and enters the UI frame cache.

The toolbar owns document metadata and the compact unverified-output status. The inspector follows the task order Exposure, Looks, Export. The Output region contains only its action; runtime progress changes that action's label, and completion uses the shared toast layer.

## Trade-offs

Six retained GPU sources cover a longer comparison journey while the smaller three-frame UI cache bounds transferable RGBA8 memory. Output, readback, and LUT memory does not scale with the number of photos. With retained source pixel counts `N1..N6`, largest workspace capacity `M`, and LUT edge `S`, GPU buffers use `6 * sum(N) + 16 * M + 12 * S^3 + 64` bytes. Six common 1024 × 683 sources and a 33³ LUT use about 35 MiB; the worst 1024 × 1024 shape uses about 52 MiB. Sensor mosaics add at most 64 MiB of WASM memory across the queue. Keeping sources avoids both RAW decode and GPU source reallocation on a cache hit; a retained mosaic also avoids compressed RAW unpack during export.

## Test Plan

- Unit-test cache activation and per-file release commands.
- Unit-test that returning to a photo does not send another decode.
- Unit-test that EV changes rerender every Look thumbnail.
- Unit-test hash-versioned HTTP cache requests, startup preparation, and progressive per-LUT publication.
- Unit-test that render backpressure retains the newest EV and refines it at 1024px.
- Unit-test that retained sources share one output workspace and one LUT, including workspace growth and independent source release.
- Verify compressed Bayer and X-Trans exports reuse a retained sensor mosaic without changing six-photo source retention.
- Run production Chromium journeys that assert two-photo return switches keep two decode marks and that a seventh distinct source evicts only the least-recently-used GPU source.
