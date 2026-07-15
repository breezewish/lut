# Web End-to-End Tests

- Selecting a RAW shows local camera metadata, transfers only display-contributing source rows into a longest-edge-1600 cache, renders Base and LUT previews, releases the short-lived LibRaw decoder, and changes positive or directly typed negative EV plus LUT through the persistent Rust renderer without another RAW decode or source-image transfer.
- A real camera RAW displays its labeled embedded JPEG before the processed preview replaces it.
- Decode, rerender, and export issue only same-origin static GET requests; no photo data is uploaded.
- The deterministic DNG decodes to exactly the same RGB16 dimensions and samples in native and WASM LibRaw builds.
- A browser-exported TIFF decodes to the same dimensions and RGB16 values within one code value of the native corrected-v2 export for the same RAW, EV, LUT, and decoder source.
- Every built-in LUT produces browser WASM RGB16 output within one code value of the optimized native corrected-v2 export.
- Two different RAW files export as separately named RGB16 TIFF entries in one ZIP; each decompressed image matches its independent native export within one code value, proving isolated sequential processing state.
- Stopping a multi-file export finishes the active file, omits the remaining files from the ZIP, and reports the partial count.
- Browser export transfers only bounded source strips into the color WASM and fails if the encoder's requested strip sizes do not consume the image exactly.
- A corrupt DNG reports a product-language decode error with recovery actions and cannot be exported as a successful file.
- At mobile width, the empty-state chooser and Add RAW action are visible before any processing controls or export action.
- The built-in LUT manifest contains only verified source files with matching SHA-256 hashes.
