# Web End-to-End Tests

- Selecting a RAW shows its labeled embedded JPEG only as a placeholder, decodes a display-sized linear source through the Preview-only LibRaw entry point, draws a longest-edge-384 processed comparison before the longest-edge-1024 settled comparison, exposes local camera metadata and readiness to assistive technology, and rerenders EV plus LUT through a persistent WebGPU source without another RAW decode or source-image transfer.
- Progressive longest-edge-384 and longest-edge-1024 frames keep identical preview Canvas geometry while changing only the pixel buffer resolution.
- EV and LUT changes show a processing spinner in Adjustments and a Processing canvas status until the exact settled recipe is rendered.
- Decode completion and export status changes do not repeat an unchanged preview recipe; continuous EV changes keep native input painting independent, commit the latest value at a bounded rate, keep at most one render active and one latest recipe waiting, publish only monotonically newer same-file and same-LUT interaction generations, reject frames from older files or LUTs, render exact-color longest-edge-1024 WebGPU frames without idle refinement, and enable export only after the final exact frame.
- Selected and batch export stay disabled while the selected RAW is decoding or its visible EV/LUT recipe is waiting to render, then become available only when that exact processed preview is ready.
- A real camera RAW displays its labeled embedded JPEG before the processed preview replaces it.
- Decode, rerender, and export issue only same-origin static GET requests; no photo data is uploaded.
- A populated queue accepts another drop, and duplicate files in the same drop event create only one queue entry.
- Synthetic LinearRaw, real Leica DNG, and Sony ARW output decode to exactly the same RGB16 dimensions and samples in native and WASM LibRaw builds in both full-size and half-size modes.
- Full-resolution export sampled to display size and fast Preview satisfy the RGB8 quality contract for Linear DNG, lossy Linear DNG, Leica Bayer DNG, rotated Leica Bayer DNG, Sony Bayer ARW, and Fujifilm X-Trans RAF; fixed crops are emitted for visual inspection.
- A legacy diagonal Fujifilm Super CCD RAF fails during format identification with a reliability error instead of displaying a processed image that disagrees materially with export.
- Real Leica DNG and Sony ARW files render nonblank previews and export full-resolution TIFFs; browser output matches native corrected-v2 output within one code value.
- The HTTPS production bundle previews and exports where WebGPU is available; browsers without WebGPU show the required compatibility error without a fake preview.
- The GitHub Pages repository-path bundle loads its manifest, LUT, Worker, and WASM assets below `/lut/` and previews a DNG without root-path requests or failed responses.
- A non-secure remote HTTP origin that cannot expose WebGPU rejects RAW processing with the required compatibility error.
- Every built-in LUT produces browser WASM RGB16 output within one code value of the optimized native corrected-v2 export.
- Two different RAW files make batch export the sole primary action, lock import, queue selection, EV, and LUT controls for the operation, and export as separately named RGB16 TIFF entries in one ZIP; each extracted TIFF matches its independent native export within one code value, proving isolated sequential processing state.
- A rapid file-selection race leaves only the final selected file and its preview active.
- A mixed-success batch continues past a decode that fails during export, includes both successful files, and reports the failed file.
- A full-resolution export failure announces its concrete error, keeps the processed preview visible, remains retryable, and removing that final queue item sends a Worker clear command before returning to the empty state.
- A valid-corrupt-valid batch exports only the two valid TIFFs, keeps their dimensions isolated, marks the corrupt file failed, continues to the later file, and reports the exact partial-success summary.
- Stopping a multi-file export finishes the active file, omits the remaining files from the ZIP, and reports the partial count.
- Browser export reads bounded zero-copy LibRaw views, transfers only bounded source batches into WebGPU color processing, and fails if the encoder's requested strip sizes do not consume the image exactly.
- An opt-in hardware test exports the Sony Bayer RAW through tiled WebGPU AAHD,
  direct GPU corrected-v2 color/LUT processing, two bounded output readbacks,
  and streamed TIFF encoding; one cold and four warm TIFFs are each decoded,
  every RGB16 channel stays within two codes of an independent native LibRaw export, and
  the reported backend cannot be a fallback.
- A second opt-in hardware export compares every Leica M8 RGB16 channel with
  production LibRaw and covers its data-adjusted AAHD scaling maximum.
- The hardware camera matrix downloads SHA-256-pinned CC0 Nikon Z 6,
  Panasonic GH5, Bayer Fujifilm X-A5, and X-Trans Fujifilm X-T1 and X-T2 RAW files into
  an ignored cache. It rejects fallback adapters, verifies GPU AAHD for strict
  Bayer input, verifies GPU Markesteijn for both X-Trans generations, retains
  LibRaw demosaic for unsupported Panasonic geometry,
  and compares every browser TIFF channel with an independent native export.
- A test-only hardware entry compares GPU X-Trans camera RGB with a captured
  LibRaw result before highlights and color. X-T1 and X-T2 must match every
  RGB16 sample exactly; X-T1 also supplies nonempty Blend-highlight coverage to
  the end-to-end TIFF comparison.
- A synthetic hardware fixture proves that sparse ordered defect correction and
  tiled AAHD bit-match the full-frame parity route across all four Bayer phases,
  both tile axes, rectangular edge tiles, a smaller-than-tile image, and
  unequal per-channel black levels.
- Removing camera white balance from the Leica DNG makes the wrapper reproduce
  LibRaw's four-channel auto-WB pre-multipliers before WebGPU scaling, and the
  final hardware TIFF remains within two codes of production LibRaw.
- An opt-in production Chromium benchmark records cold and warm file reading, embedded JPEG, first processed frame, settled processed frame, Canvas drawing, and phased LibRaw Preview without substituting a test decoder; after those samples it records one independent full LibRaw decode, color processing, TIFF encoding, Blob, and export boundary so Export cannot contaminate Preview timings.
- An opt-in production Chromium benchmark measures at least 20 EV edits, every initially uncached built-in LUT, and at least 20 cached LUT changes from control input through Canvas drawing; it enforces the preview p95 budgets and records Worker LUT-load and color stages.
- A 60-event EV burst scheduled at nominal 60 Hz in the production Chromium bundle finishes input dispatch within 1.1 seconds, paints at least 30 monotonically newer 1024px WebGPU frames, and meets the first and final interaction latency budgets.
- The hardware Preview test verifies a non-fallback WebGPU adapter, requires the first EV response at 1024px, exercises every built-in Look, and records GPU execution plus readback time.
- Losing the shared WebGPU device makes later work fail with one explicit reload instruction; preview allocation failure releases every buffer already created and never enters a CPU renderer.
- The production build contains no ONNX Runtime, model asset, native RCD backend, benchmark worker, stage-capture entry, or CPU/GPU validation switch.
- SwiftShader CI runs the independent corrected-v2 Preview pixel oracle and exact tiled AAHD fixtures across all Bayer phases, both tile seams, small images, unequal black levels, and repeated cached workspaces. Real-camera production AAHD alignment remains an opt-in hardware test with a two-code ceiling; software WebGPU validation may use the pinned six-code ceiling.
- A main-branch GitHub Actions release gate runs production browser journeys and exact tiled AAHD checks through SwiftShader WebGPU before Pages deployment, without cloud-provider credentials or external runners.
- A checksum-verified 9568 × 6376 Sony ILCE-7RM4 RAW under 4× CPU throttling accepts at least 45 exposure input events while decode is active, keeps animation-frame gap p95 below 25 ms and every gap below 100 ms, then publishes the exact settled frame.
- A 6240 × 4168 Sony ARW produces a nontrivial full-resolution TIFF in under 30 seconds for the export operation, and a later EV preview rerender reuses the existing preview source without another RAW decode.
- A corrupt DNG reports a product-language decode error with recovery actions and cannot be exported as a successful file.
- Blocking WASM startup requests produces a visible reload instruction and clears the indefinite decoding state.
- A worker error rejects every pending processing command instead of leaving unresolved promises.
- A LUT hash mismatch, missing LUT, and hash-valid malformed compact LUT each show a specific error, stop the decoding state, disable export, and allow a later valid import.
- Duplicate files in one chooser action are ignored, drag and drop decodes the file, remove plus undo restores it, and choosing a LUT records it as a recent look.
- Malformed local recent-look preferences do not prevent the empty application from rendering or accepting RAW files.
- At mobile width, the empty-state chooser and Add RAW action are visible before any processing controls or export action.
- A processed RAW exposes Fit and 1:1-preview controls, pans Base and Look around one synchronized normalized focus, returns to Fit without changing the preview recipe, and offers keyboard view shortcuts outside form controls.
- Look discovery starts without the full catalog, expands into a searchable grouped browser, retains the current and previous choices in a four-item working set, and explains the V-Gamut/V-Log context inline.
- Below 560px only the selected Base or Look pane occupies layout, the comparison switch and visible application actions have at least 44px hit targets, and the actionable output color-space explanation remains before export.
- Switching between Light and Dark modes updates the complete application shell and persists the chosen theme across reloads without changing preview pixels.
- At a short desktop height, wheel scrolling brings the selected-file export action into the viewport.
- The asset build verifies every pinned source CUBE hash, emits a compact float32 LUT with equivalent domain and samples, and publishes only generated files whose SHA-256 matches the runtime manifest.
- Rebuilding LUT assets while the development server is running preserves the manifest and every Look URL, and reloading still completes the basic DNG preview flow.
- An unavailable or invalid LUT manifest keeps an imported RAW queued, exposes no processing or export controls, and shows a reloadable startup error instead of black preview canvases.
