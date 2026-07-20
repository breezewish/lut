# Web Specification

## Local workflow

The browser accepts multiple RAW files through a chooser or drag and drop, including dropping more files into a populated queue. Duplicate selections are ignored by file identity, including duplicates within one chooser or drop event. Every import selects the first newly added file, whether the batch contains one photo or many, and that file begins decoding. Once it is usable, the remaining files load their camera-embedded thumbnails serially when available so the filmstrip gains visual context without changing the active photo or decoding full processed previews. Embedded JPEGs are used directly and RGB bitmap thumbnails are encoded locally. The active file's embedded thumbnail is also labeled and displayed before the processed preview when available.

The selected file has Base and LUT previews. Its first processed preview uses a matrix-metered automatic exposure baseline derived from the linear image. The baseline remains an internal default; the interface exposes one relative EV control. A separate White Balance section exposes relative Temperature and Tint in `[-100, 100]`, with zero labeled As Shot and one reset for both axes. Changing EV, white balance, or LUT rerenders the cached preview without decoding RAW or metering again. EV and white-balance changes also regenerate every Look thumbnail for that photo; those thumbnails are rendered at a dedicated 132px maximum edge, cached by complete photo recipe, and generated in one interruptible batch with the selected Look first. Existing tiles remain visible while each completed result replaces its matching tile in place. Continuous adjustment input keeps the interface responsive, discards obsolete waiting recipes, and presents the final value without a growing processing backlog. Temperature uses a blue-to-amber track and Tint uses a green-to-magenta track. EV and both white-balance axes support bounded numeric entry. Every adjustment applies to all selected photos and identifies mixed values. The queue shows status, removal, and undo, while the document title shows the active file, camera, and dimensions.

Opening the application conditionally revalidates the LUT manifest and begins loading all manifest LUTs concurrently. LUT asset URLs are versioned by their manifest SHA-256 and use the browser HTTP cache, so an unchanged LUT is not downloaded again and a server update selects new content automatically.

The six most recently used photos retain their decoded display-size GPU sources. The three most recently used photos also retain presentation-ready settled comparison bitmaps and Look thumbnails in UI memory. Returning to a UI-retained photo restores its comparison and contact sheet in the photo-selection render without rereading or decoding the RAW; when its UI frame was evicted, the comparison is regenerated from the retained source. Selecting a photo outside the GPU cache performs a normal preview decode. Removing one photo releases only that photo's retained resources; clearing the queue releases all retained preview resources.

Initial processing is progressive. An embedded JPEG is only an immediate labeled placeholder. The first processed comparison is longest-edge 384 and the settled comparison is longest-edge 1024. Pointer and continuous EV or white-balance interaction uses exact-color longest-edge-256 WebGPU frames transferred as Worker-created bitmaps; after 80 ms without input, including while the pointer remains pressed, the current recipe is refined once at longest-edge 1024. Pressing a slider without changing its value keeps the current 1024px comparison. LUT selection renders a Worker-created 256px Look bitmap first and replaces it with a 1024px bitmap while retaining the unchanged Base pane. Direct numeric adjustment renders at 1024. These images fill one stable preview geometry and never change the displayed image size. The previous processed comparison remains visible until the next interaction frame atomically replaces it; an adjustment or LUT change never clears either canvas to a blank placeholder. During continuous input, completed frames for the same file and LUT may trail the control value briefly, but their generations must increase monotonically so the image keeps moving forward and never regresses. A file or LUT change immediately invalidates older frames. Only the exact current 1024px recipe may publish the settled comparison or enable export.

Preview and export have different image contracts. Preview may construct and sample only the CFA cells that contribute to the display-sized result, so edge detail, noise, moiré, and isolated pixels may differ from export. Orientation, crop, frame coverage, exposure relationships, white balance, highlight behavior, and LUT semantics remain accurate. Against full-resolution export sampled to the same display dimensions, the accepted multi-camera fixture set must have mean absolute RGB8 display difference at most 12 codes, p99 absolute difference at most 80 codes, and mean signed difference within 2 codes for every channel.

Legacy diagonal Fujifilm Super CCD layouts fail explicitly at selection because the pinned full-resolution LibRaw path does not provide a reliable color reference for them. They are never shown with a processed Preview that materially disagrees with export. Modern Fujifilm X-Trans RAF is supported.

Unsupported compression is identified from LibRaw's selected decoder rather than from the filename or camera model. Nikon High Efficiency RAW, GoPro GPR, and JPEG XL-compressed DNG fail at selection with concise English dialogs that explain the exact limitation and a compatible DNG workflow. The Nikon dialog explains the Lossless Compression camera setting; the JPEG XL dialog explains the iPhone's JPEG Lossless (Most Compatible) setting. Sigma X3F is decoded locally.

## Preview performance

The acceptance fixture is the 6240 × 4168 Sony RAW in the repository, rendered by the production Chromium bundle. When available, its embedded JPEG must appear within 0.3 seconds. A cold selection must draw the first longest-edge-384 processed comparison within 1.2 seconds and the longest-edge-1024 settled comparison within 1.5 seconds. Warm selections must draw their first processed comparison with p95 below 0.6 seconds and their settled comparison with p95 below 0.8 seconds. These boundaries begin in the file-selection handler and include file reading, Worker/WASM work, transfer, and Canvas drawing.

After the longest-edge-1024 source cache is ready on the acceptance GPU, at least 20 EV samples must show a recipe-correct longest-edge-256 interaction frame with p95 below 0.08 seconds and the refined 1024px frame with p95 below 0.2 seconds. Every LUT change must publish its 256px bitmap before its 1024px bitmap. First access across the built-in LUT set, including the two 3.3MB 65³ LUTs, must show its interaction bitmap with p95 below 0.2 seconds and its full-detail bitmap with p95 below 0.3 seconds. Previously loaded LUTs must settle below 0.2 seconds.

During a 60-event EV input burst scheduled at nominal 60 Hz, input dispatch must finish within 1.1 seconds and the acceptance GPU must publish at least 30 monotonically newer longest-edge-256 processed frames. The first interaction frame must appear within 0.08 seconds of the first input, the last interaction frame within 0.1 seconds after the last input, and the final 1024px frame within 0.5 seconds. Software WebGPU records these values as diagnostics but is not hardware performance evidence.

A ready-photo drag under the portable 4× CPU-throttled software WebGPU test must keep UI frame-gap p95 below 0.1 seconds, every gap below 0.15 seconds, input handling below 0.04 seconds, and interaction-overlapping long tasks below three. This is a UI-thread regression guard, not evidence of hardware GPU throughput.

The opt-in constrained-CPU benchmark uses a checksum-verified Sony ILCE-7RM4 RAW decoded to 9568 × 6376, exceeding 33 million pixels. Exposure is dragged while that RAW is still decoding under 4× Chromium CPU throttling. At least 45 input events must be observed, animation-frame gap p95 must stay below 25 ms, and no frame gap may reach 100 ms. The fixture is downloaded only when this benchmark is explicitly requested and is never committed.

Export always rereads the original `File` and never expands or reuses display-preview pixels. It reuses the photo's cached automatic baseline. A queued photo that has not been previewed is metered once from a display-sized WebGPU source before full-resolution export. Eligible compressed Bayer and X-Trans files reuse a retained sensor mosaic under one 64 MiB queue-wide budget, avoiding a second unpack; other files perform a fresh full-resolution LibRaw decode. Selecting a RAW never materializes a full-resolution RGB image.

Output offers TIFF and JPEG. TIFF is an uncompressed RGB16 file. JPEG is an 8-bit quality-95 file. One selected photo downloads directly with `.tif` or `.jpg`; multiple selected photos are processed serially and downloaded as one ZIP whose entries all use the selected format. The action reports the current file and position, can stop after the current file, continues past per-file export failures, and leaves a completion or partial-success summary. A corrupt file displays product-language recovery actions, disables its single-photo export, and is excluded from a multi-selection export.

Export actions remain disabled until the selected processed preview matches the visible EV and LUT. This prevents an undecoded or stale recipe from being exported before the user has compared it.

WebGPU is required for Preview and Export. A missing adapter, allocation
failure, adapter-limit violation, or lost shared device fails explicitly and
never changes to a CPU renderer. Reloading after the GPU becomes available is
the recovery action.

Export selects the demosaic stage from the RAW contract. Even, unrotated Bayer
RAW uses tiled LibRaw-parity AAHD on WebGPU. Standard, unrotated three-color
X-Trans RAW uses tiled LibRaw-parity Markesteijn demosaic on WebGPU. Linear DNG,
rotated RAW, odd Bayer geometry, legacy Fuji geometry, and spatial black-level
layouts retain LibRaw's sensor-specific demosaic and geometry processing. All routes require WebGPU
for corrected-v2 color/LUT processing and stream bounded RGB16 bands into the
selected output encoder. This preserves the accepted RAW formats without treating a GPU
failure as permission to change algorithms.

A full-resolution export failure shows the concrete error, does not invalidate an already rendered preview, and does not mislabel the RAW as undecodable. The failed file remains eligible for an explicit retry. Removing a file releases only its retained preview cache; clearing the queue releases every retained preview.

Import, queue selection, EV, and LUT controls are disabled while export is active. This keeps the visible recipe and serial Worker queue stable until the export finishes or stops after the current file.

If the local WASM processing engine cannot initialize, the active request fails with a visible reload instruction instead of remaining in a decoding state.

## Interface

The workspace is a full-width, full-height editing application identified as LUTify in the document title and top toolbar, with persistent Light and Dark modes. It is flat, borderless, shadowless, neutral, and responsive. Desktop uses a top toolbar, dominant center comparison canvas, right adjustment inspector, and bottom photo filmstrip. The filmstrip omits a redundant photo count. Processing controls are hidden before a file is selected. The adjustment inspector shows a spinner whenever its visible EV or LUT recipe is not yet fully rendered; the canvas status reports the same state instead of reporting Ready. Camera and dimensions belong to the active document title. Output contains one format selector and one export action; progress is shown in that button and completion is announced in a toast. The output color-space assumption remains visible as a compact amber status in the toolbar. Desktop actions and fields use compact 30–36 px bodies; coarse-pointer and narrow-viewport actions retain at least 44 px targets. At narrow widths the canvas and inspector stack while the compact Output controls remain reachable below the internally scrolling Look catalog. Reduced-motion preferences are honored.

The comparison toolbar offers Wipe and Split modes. Wipe overlays Base and Look with a draggable, keyboard-adjustable divider. Split places the complete Base and Look frames side by side.

Look selection uses a stable searchable thumbnail catalog grouped under visible source camera-family headings from the LUT manifest. Camera-native looks begin with the uppercase short label photographers see in-camera, such as `STD | Provia` and `NC | Classic Neg.`; technical transforms remain unprefixed. Each tile previews the active photo with that Look at the active EV. The compact output color-space warning states that the exported file must be checked before production use.

## Privacy and assumptions

RAW and decoded data stay in the browser worker. The application fetches only its own static code and built-in LUT assets. The UI states that files stay on the device and that LUT output color semantics are undocumented.
