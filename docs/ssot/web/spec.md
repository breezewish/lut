# Web Specification

## Local workflow

The browser accepts multiple RAW files through a chooser or drag and drop, including dropping more files into a populated queue. Duplicate selections are ignored by file identity, including duplicates within one chooser or drop event. The first selected file begins decoding. A JPEG thumbnail embedded by the camera is labeled and displayed before the processed preview when available.

The selected file has side-by-side Base and LUT previews. Changing EV or LUT rerenders the cached preview without decoding RAW again. Continuous EV input keeps the interface responsive, discards obsolete waiting recipes, and presents the final value without a growing processing backlog. Look selection supports text search and recent choices; malformed local recent-choice data is ignored. EV supports a slider and bounded numeric entry. The queue shows textual status, camera, dimensions, removal, clear, and undo.

Initial processing is progressive. An embedded JPEG is only an immediate labeled placeholder. The first processed comparison is longest-edge 384 and the settled comparison is longest-edge 1024. On WebGPU, every interactive EV or LUT result is a longest-edge-1024 exact-color frame; there is no coarse interaction phase or idle refinement delay. The CPU fallback uses longest-edge-256 exact-color interaction frames before the same 1024 refinement. These buffers fill one stable preview geometry and never change the displayed image size. The previous processed comparison remains visible until the next interaction frame atomically replaces it; an EV or LUT change never clears either canvas to a blank placeholder. During continuous EV input, completed frames for the same file and LUT may trail the control value briefly, but their generations must increase monotonically so the image keeps moving forward and never regresses. A file or LUT change immediately invalidates older frames. Only the exact current recipe may publish the settled comparison or enable export.

Preview and export have different image contracts. Preview may use half-size CFA reconstruction and display-sized sampling, so edge detail, noise, moiré, and isolated pixels may differ from export. Orientation, crop, frame coverage, exposure relationships, white balance, highlight behavior, and LUT semantics remain accurate. Against full-resolution export sampled to the same display dimensions, the accepted multi-camera fixture set must have mean absolute RGB8 display difference at most 12 codes, p99 absolute difference at most 80 codes, and mean signed difference within 2 codes for every channel.

Legacy diagonal Fujifilm Super CCD layouts fail explicitly at selection because the pinned full-resolution LibRaw path does not provide a reliable color reference for them. They are never shown with a processed Preview that materially disagrees with export. Modern Fujifilm X-Trans RAF is supported.

## Preview performance

The acceptance fixture is the 6240 × 4168 Sony RAW in the repository, rendered by the production Chromium bundle. When available, its embedded JPEG must appear within 0.3 seconds. A cold selection must draw the first longest-edge-384 processed comparison within 1.2 seconds and the longest-edge-1024 settled comparison within 1.5 seconds. Warm selections must draw their first processed comparison with p95 below 0.6 seconds and their settled comparison with p95 below 0.8 seconds. These boundaries begin in the file-selection handler and include file reading, Worker/WASM work, transfer, and Canvas drawing.

After the longest-edge-1024 source cache is ready on the acceptance GPU, at least 20 EV samples must show a recipe-correct longest-edge-1024 frame with p95 below 0.08 seconds. First access to the built-in LUT set and a previously loaded LUT must each show that full-detail frame with p95 below 0.2 seconds. The CPU fallback retains the progressive interaction budgets but is not the hardware performance reference.

During a 60-event EV input burst scheduled at nominal 60 Hz, input dispatch must finish within 1.1 seconds and the acceptance GPU must publish at least 30 longest-edge-1024 processed frames. The first frame must appear within 0.08 seconds of the first input and the final exact frame within 0.1 seconds after the last input.

The opt-in constrained-CPU benchmark uses a checksum-verified Sony ILCE-7RM4 RAW decoded to 9568 × 6376, exceeding 33 million pixels. Exposure is dragged while that RAW is still decoding under 4× Chromium CPU throttling. At least 45 input events must be observed, animation-frame gap p95 must stay below 25 ms, and no frame gap may reach 100 ms. The fixture is downloaded only when this benchmark is explicitly requested and is never committed.

Export always rereads the original `File` and performs a fresh full-resolution LibRaw decode. It never reads, expands, or reuses preview pixels. Selecting a RAW never performs the full-resolution decode.

Export selected downloads one uncompressed RGB16 TIFF. Export all processes nonfailed queue entries serially and downloads one ZIP containing uncompressed TIFF entries. It reports the current file and position, can stop after the current file, continues past per-file failures, and leaves a completion or partial-success summary. A corrupt file displays product-language recovery actions, disables its selected export, and is skipped by batch export.

Export actions remain disabled until the selected processed preview matches the visible EV and LUT. This prevents an undecoded or stale recipe from being exported before the user has compared it.

The default export uses pinned LibRaw. An explicit experimental
`rawBackend=webgpu-aahd` query is available for supported Bayer RAW files. It
uses tiled LibRaw-parity AAHD and corrected-v2 color/LUT processing on WebGPU,
then streams bounded RGB16 bands into the TIFF encoder. Missing WebGPU,
unsupported sensors, and adapter limits fail explicitly; the experimental
route never changes decoder silently.

A full-resolution export failure shows the concrete error, does not invalidate an already rendered preview, and does not mislabel the RAW as undecodable. The failed file remains eligible for an explicit retry. Removing the selected file or clearing the queue releases its persistent decoded preview cache.

Import, queue selection, EV, and LUT controls are disabled while export is active. This keeps the visible recipe and serial Worker queue stable until the export finishes or stops after the current file.

If the local WASM processing engine cannot initialize, the active request fails with a visible reload instruction instead of remaining in a decoding state.

## Interface

The workspace is a full-width, full-height editing application with persistent Light and Dark modes. It is flat, borderless, shadowless, neutral, and responsive. Desktop uses a top toolbar, left file queue, dominant center comparison canvas, and right adjustment/output inspector. Processing controls are hidden before a file is selected. The adjustment inspector shows a spinner whenever its visible EV or LUT recipe is not yet fully rendered; the canvas status reports the same state instead of reporting Ready. The task order is edit, compare, then export in both DOM and visual flow. Desktop actions and fields use compact 30–36 px bodies; coarse-pointer and narrow-viewport actions retain at least 44 px targets. Side-by-side comparison remains until the viewport is narrower than 35rem. Narrow layouts use one image well with an explicit Base/Look switch so comparison does not push Output behind two full canvases. Medium layouts use a horizontal source queue; narrow layouts follow the vertical workflow of queue, adjustments, comparison, and output. Short viewports keep export reachable. Reduced-motion preferences are honored.

The comparison toolbar offers synchronized Fit and 1:1-preview views. The 1:1 view displays the processed preview buffer at one CSS pixel per preview pixel and supports synchronized pointer panning across Base and Look. It is explicitly a preview inspection aid, not a claim that the display-sized preview is a full-resolution RAW decode. `F` selects Fit and `1` selects 1:1 when focus is outside a form control.

Look selection starts with the current look and at most four recent working choices. The full catalog is progressively disclosed through a searchable, grouped browser that can remain open while looks are compared. Inline help explains the V-Gamut/V-Log processing context. The output color-space warning states the downstream risk, the required verification action, and why the TIFF intentionally has no embedded profile.

## Privacy and assumptions

RAW and decoded data stay in the browser worker. The application fetches only its own static code and built-in LUT assets. The UI states that files stay on the device and that LUT output color semantics are undocumented.
