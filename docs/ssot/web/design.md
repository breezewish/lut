# Web Design

## Runtime

React owns queue and control state. `ProcessingClient` pairs commands with worker replies. One promise tail in the Dedicated Worker serializes decode, rerender, and export, preventing LibRaw state races and batch contamination. Runtime initialization is awaited once per command; if either WASM module fails to start, the Worker replies with a product-level recovery error without awaiting the rejected initialization again.

The application is a static project site. One Vite base path applies to the entry bundle, Worker, WASM, isolation service worker, manifest, and LUT assets, so the same build model works at an origin root or a repository subpath. The service worker adds same-origin COOP, COEP, and CORP headers before application startup, enabling the optional LibRaw pthread runtime without server-specific configuration. Development and preview servers send the same headers directly, avoiding a controlled reload where the server already owns the response. Rust, lightweight web checks, and browser production tests run independently. The browser job downloads the checksum-pinned Nikon Z 6 NEF and generates a bounded X-Trans DNG to verify both LibRaw sensor and GPU-routing boundaries, then runs the product journey, a bounded production AAHD export, and exact tiled AAHD checks through Chromium's SwiftShader WebGPU implementation. It finally tests the repository-path bundle and uploads that exact output as an immutable Pages artifact. Software WebGPU is a portable correctness gate, not hardware performance or driver-compatibility evidence; full-resolution camera and X-Trans shader parity remain a non-fallback hardware suite. CI has no cloud-provider credentials or external runner trust. A `main` deployment waits for every verification job and never rebuilds or commits generated output.

Source CUBE files are pinned and verified during the asset build, then encoded as a compact little-endian float32 format. The runtime manifest hashes those generated assets. App startup conditionally revalidates the manifest, then the Worker starts every compact LUT request concurrently while WASM and RAW work continue. Each LUT URL includes its manifest SHA-256 and uses the browser HTTP cache, so unchanged content remains a local cache hit while a changed hash creates a new URL. The Worker verifies downloaded bytes through the browser's asynchronous native SHA-256 implementation when available and retains every parsed LUT used during the session in a map. A failed byte request is removed from the pending map, allowing a later explicit photo retry after connectivity or server content is repaired. The bundled portable implementation preserves identical verification on non-secure origins without Web Crypto. The verified byte array crosses one WASM binding and becomes the immutable Rust LUT without runtime text decoding or floating-point parsing, then the duplicate byte array is released. Preview and export acquire the same per-device GPU upload from a 32 MiB LRU keyed by the parsed LUT.

The minimal LibRaw wrapper has no whole-image JavaScript return API. Export retains one processed RGB16 allocation, exposes bounds-checked zero-copy views, and releases the input RAW plus intermediate decoder state as soon as processing finishes.

Preview uses a separate `openPreview` contract. LibRaw still identifies and unpacks the original RAW and provides its camera metadata, active area, crop, black levels, white balance, and color matrix. For standard Bayer input, the wrapper constructs only the CFA cells that contribute to the orientation-correct longest-edge-1024 result instead of copying and scanning every half-size sensor cell. Preview normalization uses the camera white level rather than a per-photo maximum derived by a full sensor scan. Highlight, camera-to-output color work, and RGB16 materialization therefore run only on display-sized data. This approximation is isolated from export and bounded by the display-space quality contract.

X-Trans, linear or multi-channel input, legacy Fuji geometry, and non-square pixels do not use the early Bayer construction. Their sensor-specific completion or geometry stays in LibRaw, after which the existing orientation-aware display-sized selection runs at the earliest correct phase. Orientation-aware source and destination indexing makes that selection commute with LibRaw's final flip/transpose copy. Rust performs any remaining final display sampling.

The wrapper rejects legacy diagonal Fujifilm Super CCD geometry after identification and before unpack. The pinned LibRaw full-resolution path produces materially different color from its half-size path on this layout, so neither result is a defensible Preview reference. Failing explicitly avoids presenting a misleading comparison. Modern Fujifilm X-Trans follows the display-sized path.

The Worker transfers the resulting source rows into a temporary Rust renderer, uploads the completed longest-edge-1024 RGB16 source to WebGPU, then destroys the Rust renderer. Before the first processed frame, a compute pass atomically reduces the resident source into 7 × 7 luminance statistics and a 1024-bin max-RGB histogram. The Worker reads back only 4,488 bytes, resolves the matrix-metered baseline, and stores that EV with the photo source and UI queue item. An LRU retains six independent photo source buffers. One renderer owns one Base output, Look output, and two readback buffers shared across every retained source. The serialized Worker selects a source before each render, so previews never execute concurrently; its workspace grows only when a selected source exceeds the previous capacity and then remains reusable. Idle GPU LUT uploads use an independent 32 MiB LRU and are shared with export. GPU memory is bounded by `6 * sum(source pixels) + 16 * largest source pixels + 32 MiB LUT cache`, excluding negligible parameters and buffers held by active work. Activation touches a retained photo without rendering; a cache miss is explicit and starts the normal decode path. The UI independently retains three photos' settled comparisons, Look thumbnails, and baseline EV values.

For compressed strict WebGPU demosaic input, Preview may also retain a contiguous visible sensor mosaic for full-resolution export. Sensor mosaics share one 64 MiB budget across the six-photo LRU; evicting a sensor keeps its display-sized GPU source warm. The mosaic copy and decoder-adjusted black-level snapshot precede LibRaw processing, while full-frame maximum analysis runs after the settled frame is published. This snapshot is required because processing some DNG files mutates LibRaw's internal black table. Uncompressed input retains no sensor mosaic. A lazy pthread LibRaw runtime accelerates supported compressed unpack when the mosaic is not retained.

Settled comparisons are converted into transferable `ImageBitmap` objects in the Worker before entering the three-photo UI cache. LUT-only comparison changes retain the unchanged Base bitmap and transfer only the new Look bitmap. The shared device and Preview shader begin initialization when the Worker starts, in parallel with file selection and LibRaw work. Initial decode publishes a 384px processed comparison before the 1024px settled comparison. The embedded JPEG remains a labeled placeholder and never enters this renderer. WebGPU is required; no retained source is a fallback renderer.

The exposure slider remains an uncontrolled native input while the pointer moves. Its value is relative to an automatic baseline that stays internal. Its thumb, progress fill, numeric readout, and accessibility value update immediately without a React render. Pointer-down alone changes no Preview state. The first changed value invalidates export readiness immediately. Drag EV is transient preview state; the selected photos' persistent EV changes when the pointer gesture ends or input has been idle for 80 ms. One WGSL dispatch reads the resident RGB16 source, applies `baseline EV + relative EV`, corrected-v2 Base or V-Log/LUT color, and writes display-ready RGBA8. The main-thread client permits one render in flight and coalesces all later changes into one latest recipe; completion, rather than input frequency, applies backpressure to the next render. Slider interaction renders at longest-edge 256. The Worker converts both panes to transferable `ImageBitmap` objects, keeping transient RGBA arrays and their garbage collection off the UI thread. After 80 ms without input even while the pointer remains down, or when the pointer gesture ends, one longest-edge-1024 pixel frame refines the current recipe. Completed interaction results carry monotonic generations. While EV changes continue for one file and LUT, any newer completed generation may replace the canvas even if a still-newer value is waiting; an older generation can never replace it. File and LUT identity remain strict invalidation boundaries. Every LUT change renders the LUT pane first at 256px and then at 1024px while reusing the settled Base pane. Both LUT results are Worker-created bitmaps, so neither allocates a large transient RGBA array on the UI thread. Only the exact current 1024px recipe enables export.

Look previews are submitted as one Worker command as soon as the main recipe settles. The selected Look renders first because its LUT is already parsed for the main preview. Remaining LUTs render in byte-readiness order, allowing HTTP transfer, integrity verification, WASM parsing, GPU work, transfer, and Canvas publication to overlap as a pipeline. The Worker checks main-preview priority between each 132px LUT render, creates its `ImageBitmap` off the main thread, and transfers every completed thumbnail immediately. Displayed tiles and completed tiles are distinct state: a new EV starts an empty completion set without clearing the canvases, then each result replaces one old tile in a low-priority React transition. Memoized comparison, Look, and filmstrip surfaces do not reconcile for unrelated EV state commits. A preempted batch resumes with only missing LUTs, so interaction cannot accumulate thumbnail work or repeat completed tiles.

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
pthread LibRaw runtime uses the calling thread and at most three pooled workers
for proven independent blocks, planes, rows, or tiles. The selected decoders
are Fujifilm compressed, Panasonic C8, Canon CRX, Sony ARW2, and large
8–15-bit single-sample packed DNG. Other decoder functions remain on the
regular WASM runtime. Full-resolution GPU Markesteijn
would add work and memory before discarding almost every result pixel. Preview
may differ slightly from export under its existing display-space quality
contract.

RAWs outside the WebGPU demosaic contracts complete demosaic and
geometry in LibRaw, then enter the same required WebGPU color and bounded TIFF
path. Device failures never select the LibRaw route.

Successful preview and export replies carry monotonic diagnostic timings. The LibRaw wrapper records input copy, open, unpack, preprocessing, preview resizing, demosaic, postprocessing, RGB conversion, and RGB16 creation at the real processing seams. File selection, file reading, embedded JPEG publication, initial processed frames, Canvas drawing, TIFF encoding, and Blob construction publish named Performance marks for opt-in production-path benchmarks. These diagnostics do not change the selected algorithm or image data.

Queue removal sends a serialized release command for that photo and frees its GPU source plus any retained sensor mosaic; clearing the final item or the entire queue also frees the shared renderer workspace. Decode and export failures are separate queue states: only decode failure makes the RAW ineligible, while export failure retains the preview and allows another full-resolution attempt.

The browser wrapper turns LibRaw decoder identities that are explicitly flagged unsupported into stable internal error codes before unpacking. The application maps Nikon High Efficiency, GoPro GPR, and JPEG XL-compressed DNG codes to focused native modal dialogs; generic unsupported or damaged RAW errors remain in the shared toast path. This keeps recovery guidance specific without guessing from extensions or camera names. The WASM build enables LibRaw's bundled X3F decoder so Sigma files stay in the normal local decode path.

## Presentation

Tailwind supplies reset infrastructure only; the visual system is a bespoke token-driven stylesheet plus a small component layer. A search field filters the stable visual Look grid. Product layout, authored form controls, and Light/Dark theme tokens live in `styles.css`. Color uses OKLCH throughout with exactly two text tones (`--ink`, `--ink-muted`), both verified at or above 4.5:1 contrast against every surface they appear on; a third neutral (`--line`) is decoration-only (hairlines, tick marks, disabled glyphs) and never carries text. One evolved spectral-blue accent identifies primary actions, selection, and active values; amber identifies the unverified output assumption. Both themes retain neutral dark image wells so the application shell does not alter color judgment. Interactive `Button` variant and size are expressed as `data-variant`/`data-size` attributes, decoupling automated tests from presentational class names.

The Canvas element fills its image well independently of its pixel buffer dimensions. Initial 384px, interaction 256px, and settled 1024px frames therefore replace image data without changing layout geometry. The adjustment header derives its processing indicator from the same exact recipe equality that gates export, so EV and LUT changes remain visibly pending until the exact frame is published.

Wipe and Split are presentation-only views of the existing Canvas buffers. Wipe stacks both panes and updates one CSS clipping variable while its divider moves, without copying pixels, scheduling Worker work, or entering React on every pointer frame. Split places two complete frames side by side. File selection resets the divider to center.

Desktop presentation is a stable editing shell: document actions and active camera metadata live in the 48px top toolbar, comparison dominates the center canvas, adjustments occupy the right inspector, and photos form a resizable bottom filmstrip. The filmstrip itself communicates queue size, so it has no separate count label. Exposure remains fixed above the internally scrolling Look grid. Output is only the final export button, leaving maximum height for visual Look selection; export progress uses the button and completion uses the shared toast layer. The unverified output assumption moves to a compact amber toolbar status rather than consuming inspector space. Queue status is conveyed per-item by an icon and fill. Empty states omit editing and export controls. At narrow widths the workspace stacks comparison above the inspector and reduces filmstrip height. Desktop controls use 30–36px bodies and 6px radii; coarse-pointer actions expand to 44px targets. Add, recovery, and destructive row actions remain visible on touch layouts.

Below 560px, both preview canvases remain mounted in the selected Wipe or Split comparison. Narrow-viewport controls enforce 44px hit targets even when a browser does not expose the coarse-pointer media feature.

The Look control exposes the complete stable thumbnail grid with text filtering. Manifest groups are source-provenance camera families and render as visible sticky headings. Each manifest name is the complete user-facing label and search term; camera-native looks include their in-camera short label, while technical transforms do not invent one. Selection never reorders the catalog, so users can compare adjacent transforms without losing spatial context.

Output contains one primary action. It exports the active photo when selection is singular and changes to the selected-photo count for a multi-selection. Queue selection and preview readiness are exposed through ARIA state, and each rendered canvas is identified as an image.

Both export actions derive from one readiness condition: the selected file has a usable processed preview and its rendered recipe key exactly matches the visible file, EV, and LUT. Decode and rerender transitions therefore cannot start an export with an unreviewed recipe or overwrite a decode failure with a concurrent export failure.

Batch export has one mutable operation state: the current index, total, and file name. Stop requests are checked after the active file finishes, preserving the single-worker execution model. Per-file failures update that queue item and do not abort remaining eligible files. The main thread streams completed uncompressed TIFFs into pass-through ZIP entries, preserving the fast single-file encoding path and avoiding another contiguous archive copy. The final ZIP chunks remain in memory because portable browser downloads require a Blob; direct filesystem streaming is not assumed.

While that serial operation is active, import, queue selection, exposure, and look controls are disabled. The export therefore has one immutable target list and recipe, and interactive preview commands cannot be inserted between batch files.
