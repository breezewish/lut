# Web Design

## Runtime

React owns queue and control state. `ProcessingClient` pairs commands with worker replies. One promise tail in the Dedicated Worker serializes decode, rerender, and export, preventing LibRaw state races and batch contamination. Runtime initialization is awaited once per command; if either WASM module fails to start, the Worker replies with a product-level recovery error without awaiting the rejected initialization again.

The application is a static project site. One Vite base path applies to the entry bundle, Worker, WASM, isolation service worker, manifest, and LUT assets, so the same build model works at an origin root or a repository subpath. The service worker adds same-origin COOP, COEP, and CORP headers before application startup, enabling the optional LibRaw pthread runtime without server-specific configuration. Development and preview servers send the same headers directly, avoiding a controlled reload where the server already owns the response. Rust, lightweight web checks, and browser production tests run independently. The browser job runs the product journey and exact tiled AAHD checks through Chromium's SwiftShader WebGPU implementation, then tests the repository-path bundle and uploads that exact output as an immutable Pages artifact. This software implementation is a portable correctness gate, not hardware performance or driver-compatibility evidence. CI has no cloud-provider credentials or external runner trust. A `main` deployment waits for every verification job and never rebuilds or commits generated output.

Source CUBE files are pinned and verified during the asset build, then encoded as a compact little-endian float32 format. The runtime manifest hashes those generated assets. The worker loads each compact LUT on demand, verifies SHA-256 with the bundled portable implementation, and retains every LUT used during the session in a map. Hash verification therefore has one behavior in secure production origins, loopback development, and non-secure remote development origins; it does not depend on the secure-context-only Web Crypto API. The verified byte array crosses one WASM binding and becomes the immutable Rust LUT without runtime text decoding or floating-point parsing. Preview and export reuse that parsed value without a second megabyte-scale string or hundreds of thousands of scalar binding calls.

The minimal LibRaw wrapper has no whole-image JavaScript return API. Export retains one processed RGB16 allocation, exposes bounds-checked zero-copy views, and releases the input RAW plus intermediate decoder state as soon as processing finishes.

Preview uses a separate `openPreview` contract. LibRaw still identifies and unpacks the original RAW and provides its camera metadata, active area, crop, black levels, white balance, and color matrix. For standard Bayer input, the wrapper constructs only the CFA cells that contribute to the orientation-correct longest-edge-1024 result instead of copying and scanning every half-size sensor cell. Preview normalization uses the camera white level rather than a per-photo maximum derived by a full sensor scan. Highlight, camera-to-output color work, and RGB16 materialization therefore run only on display-sized data. This approximation is isolated from export and bounded by the display-space quality contract.

X-Trans, linear or multi-channel input, legacy Fuji geometry, and non-square pixels do not use the early Bayer construction. Their sensor-specific completion or geometry stays in LibRaw, after which the existing orientation-aware display-sized selection runs at the earliest correct phase. Orientation-aware source and destination indexing makes that selection commute with LibRaw's final flip/transpose copy. Rust performs any remaining final display sampling.

The wrapper rejects legacy diagonal Fujifilm Super CCD geometry after identification and before unpack. The pinned LibRaw full-resolution path produces materially different color from its half-size path on this layout, so neither result is a defensible Preview reference. Failing explicitly avoids presenting a misleading comparison. Modern Fujifilm X-Trans follows the display-sized path.

The Worker transfers the resulting source rows into a temporary Rust renderer and moves the completed longest-edge-1024 RGB16 source into one persistent WebGPU storage buffer. For compressed strict WebGPU demosaic input, it also retains one contiguous visible sensor mosaic of at most 64 MiB for export. The mosaic copy precedes LibRaw processing, while its full-frame maximum analysis runs after the settled frame is published. Uncompressed input retains no sensor mosaic. The current LUT, Base and Look output buffers, and two readbacks remain allocated across rerenders. The preview-only workspace is below 26 MB at a square 1024px maximum, excluding the shared device and optional export mosaic. The shared device and Preview shader begin initialization when the Worker starts, in parallel with file selection and LibRaw work. Initial decode publishes a 384px processed comparison before the 1024px settled comparison. The embedded JPEG remains a labeled placeholder and never enters this renderer. WebGPU is required; the temporary Rust source is never retained as a fallback renderer.

The exposure slider remains an uncontrolled native input while the pointer moves. Its thumb, progress fill, numeric readout, and accessibility value update immediately without a React render. The latest value enters React at most once every 16 ms through an interruptible transition. The first event invalidates export readiness immediately. One WGSL dispatch reads the resident RGB16 source, applies EV, corrected-v2 Base or V-Log/LUT color, and writes display-ready RGBA8. WebGPU renders the 1024px result immediately and does not schedule a coarse interaction frame or refinement delay. The main-thread client permits one render in flight and coalesces all later changes into one latest recipe, so continuous input cannot grow a backlog. Completed interaction results carry monotonic generations. While EV changes continue for one file and LUT, any newer completed generation may replace the canvas even if a still-newer value is waiting; an older generation can never replace it. File and LUT identity remain strict invalidation boundaries. LUT changes render and transfer only the LUT pane because the Base pane does not depend on LUT selection. EV changes render both panes. Only the exact current recipe enables export.

The WebGPU implementation evaluates the canonical Preview transfer directly. Export retains its independent exact floating-point processing path. Transferred RGBA8 results are reinterpreted directly as clamped Canvas views instead of copied into another complete preview allocation. Export receives a fresh transferable RAW buffer, but strict compressed Bayer and X-Trans routes reuse the cached sensor mosaic instead of unpacking it again. Other routes decode on demand. A stateful Rust WASM encoder requests and copies only the next approximately 1 MB LibRaw view, so JavaScript never owns a complete decoded RGB16 image and the separate color WASM receives no second complete allocation.

The production Export route asks LibRaw whether the opened RAW satisfies the
strict WebGPU Bayer AAHD or X-Trans contract before choosing a demosaic stage. LibRaw
opens and unpacks the visible Bayer mosaic and exposes the effective AAHD
scaling range after its adjusted-maximum policy. The wrapper also exposes the
four normalized pre-multipliers selected by LibRaw's camera-white-field,
camera-WB, or auto-WB policy; the uncommon auto-WB scan reuses the visible
mosaic already copied for WebGPU. WebGPU subtracts each CFA
channel's adjusted black level, scales the CFA, collects
extrema, and classifies the initial defects in parallel. A sparse CPU scan
enumerates only classified pixels in LibRaw row order and schedules every later
classification affected by a correction, preserving exact cascades. A shared
WebGPU device runs a
1024-core, 12-halo two-sweep parity pipeline. The first sweep reads directions
back into one CPU plane for exact row-order refinement; that scan emits one
packed four-bit direction plane consumed directly by every tile in the second
sweep. Exact YUV rounding uses one dispatch with explicit storage round trips.
Each selected core passes directly into corrected-v2 exposure and LUT
processing. Two fixed output readbacks overlap bounded transfer with TIFF
prediction and Deflate; a separate scratch readback supports the compact exact
Blend-highlight transform.

Standard X-Trans export keeps LibRaw unpacking, crop metadata, black levels,
white balance, and color matrices, then runs its three-pass eight-direction
Markesteijn algorithm in 512px WebGPU tiles. Eight-pixel row and column overlap
buffers reproduce LibRaw's scan-order image state. Final border interpolation
is kept separate from that overlap state. CIELab matrix products and additions
cross explicit storage boundaries because WGSL permits contraction while the
pinned LibRaw build forbids it. The same rule applies to the final Lab terms.
The bounded workspace is at most 179 MB for the verified camera matrix, with no
full decoded RGB image in JavaScript. Blend highlight reconstruction, ProPhoto
conversion, corrected-v2 color, readback, and TIFF writing remain on the
streamed tile route.

Preview intentionally retains LibRaw's display-sized X-Trans path. A lazy
pthread LibRaw runtime decodes independently compressed Fujifilm blocks with
the calling thread and at most three pooled workers. Sequential decoder
functions remain on the regular WASM runtime. Full-resolution GPU Markesteijn
would add work and memory before discarding almost every result pixel. Preview
may differ slightly from export under its existing display-space quality
contract.

RAWs outside the WebGPU demosaic contracts complete demosaic and
geometry in LibRaw, then enter the same required WebGPU color and bounded TIFF
path. Device failures never select the LibRaw route.

Successful preview and export replies carry monotonic diagnostic timings. The LibRaw wrapper records input copy, open, unpack, preprocessing, preview resizing, demosaic, postprocessing, RGB conversion, and RGB16 creation at the real processing seams. File selection, file reading, embedded JPEG publication, initial processed frames, Canvas drawing, TIFF encoding, and Blob construction publish named Performance marks for opt-in production-path benchmarks. These diagnostics do not change the selected algorithm or image data.

Queue removal sends an explicit serialized clear command that frees the persistent Rust preview renderer. Decode and export failures are separate queue states: only decode failure makes the RAW ineligible, while export failure retains the preview and allows another full-resolution attempt.

## Presentation

Tailwind supplies reset infrastructure only; the visual system is a bespoke token-driven stylesheet plus a small component layer using Radix Select. A separate search field filters the grouped Select without replacing its familiar keyboard behavior; recent LUT identifiers are a nonessential local preference. Product layout, authored form controls, and Light/Dark theme tokens live in `styles.css`. Color uses OKLCH throughout with exactly two text tones (`--ink`, `--ink-muted`), both verified at or above 4.5:1 contrast against every surface they appear on; a third neutral (`--line`) is decoration-only (hairlines, tick marks, disabled glyphs) and never carries text. One evolved spectral-blue accent identifies primary actions, selection, and active values; amber identifies the unverified output assumption. Both themes retain neutral dark image wells so the application shell does not alter color judgment. Interactive `Button` variant and size are expressed as `data-variant`/`data-size` attributes, decoupling automated tests from presentational class names.

The Canvas element fills its image well independently of its pixel buffer dimensions. The initial 384px and 1024px frames and WebGPU 1024px interaction frames therefore replace image data without changing layout geometry. The adjustment header derives its processing indicator from the same exact recipe equality that gates export, so EV and LUT changes remain visibly pending until the exact frame is published.

Fit and 1:1-preview inspection are presentation-only views of those existing Canvas buffers. A shared normalized focal point positions both canvases, so pointer panning stays synchronized without copying pixels, scheduling Worker work, or entering React on every pointer frame. File selection resets the view to Fit and the focal point to center. The 1:1 label refers to preview pixels; export remains the only full-resolution decode.

Desktop presentation is a stable editing shell: document actions live in the 48px top toolbar, the compact local source queue occupies the left rail, comparison dominates the center canvas, and adjustments plus output occupy the right inspector. The inspector precedes the canvas in DOM order — its Adjustments section keeps EV and Look together as one Tab sequence, ending in the Output section's export action — while `order` decouples visual layout so the canvas remains the dominant surface regardless of source position. Queue status is conveyed per-item by an icon (not a side accent stripe), so status remains legible without adding a decorative border. Empty states omit editing and export controls. At medium width the file queue becomes horizontal while previews remain side by side. Below 700px the workflow becomes vertical; below 560px comparison switches to one selectable pane. Desktop controls use 30–36px bodies and 6px radii; coarse-pointer actions expand to 44px targets. Add, recovery, and destructive row actions remain visible on touch layouts.

Below 560px, both preview canvases remain mounted but only the selected Base or Look pane participates in layout. A two-choice segmented control changes the visible pane and reduces the distance from adjustments to output. Narrow-viewport controls enforce 44px hit targets even when a browser does not expose the coarse-pointer media feature.

The Look control exposes one current selection and a maximum four-item recent working set. A separate explicit action expands the complete searchable grouped catalog; it stays open across selections to support rapid comparison. This progressive disclosure avoids presenting all 27 transforms as one immediate decision while preserving direct catalog access and Radix keyboard behavior.

The single-file journey gives `Export selected` the primary treatment. Once the queue contains multiple files, `Export all` becomes the sole primary action and the selected-file export becomes secondary. Queue selection and preview readiness are exposed through ARIA state, and each rendered canvas is identified as an image.

Both export actions derive from one readiness condition: the selected file has a usable processed preview and its rendered recipe key exactly matches the visible file, EV, and LUT. Decode and rerender transitions therefore cannot start an export with an unreviewed recipe or overwrite a decode failure with a concurrent export failure.

Batch export has one mutable operation state: the current index, total, and file name. Stop requests are checked after the active file finishes, preserving the single-worker execution model. Per-file failures update that queue item and do not abort remaining eligible files. The main thread streams completed uncompressed TIFFs into pass-through ZIP entries, preserving the fast single-file encoding path and avoiding another contiguous archive copy. The final ZIP chunks remain in memory because portable browser downloads require a Blob; direct filesystem streaming is not assumed.

While that serial operation is active, import, queue selection, exposure, and look controls are disabled. The export therefore has one immutable target list and recipe, and interactive preview commands cannot be inserted between batch files.
