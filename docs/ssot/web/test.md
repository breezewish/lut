# Web End-to-End Tests

- Selecting a RAW shows local camera metadata, renders Base and LUT previews, and changes EV and LUT without incrementing the worker decode count.
- A real camera RAW displays its labeled embedded JPEG before the processed preview replaces it.
- Decode, rerender, and export issue only same-origin static GET requests; no photo data is uploaded.
- The deterministic DNG decodes to exactly the same RGB16 dimensions and samples in native and WASM LibRaw builds.
- A browser-exported TIFF decodes to the same dimensions and RGB16 values within one code value of the native corrected-v2 export for the same RAW, EV, LUT, and decoder source.
- Every built-in LUT produces browser WASM RGB16 output within one code value of the optimized native corrected-v2 export.
- Two identical RAW files export as two named RGB16 TIFF entries in one ZIP; their decompressed pixels are exactly equal, proving isolated sequential processing state.
- A corrupt DNG reports a product-language decode error with recovery actions and cannot be exported as a successful file.
- At mobile width, the empty-state chooser and Add RAW action are visible before any processing controls or export action.
- The built-in LUT manifest contains only verified source files with matching SHA-256 hashes.
