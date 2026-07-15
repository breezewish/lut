# Web End-to-End Tests

- Selecting a real lossy DNG shows local camera metadata, renders Base and LUT previews, changes EV without losing the preview, and downloads a TIFF.
- The deterministic DNG decodes to exactly the same RGB16 dimensions and samples in native and WASM LibRaw builds.
- A browser-exported TIFF decodes to the same dimensions and RGB16 values within one code value of the native corrected-v2 export for the same RAW, EV, LUT, and decoder source.
- Two RAW files export as one ZIP with isolated sequential processing state.
- A corrupt DNG reports a product-language decode error with recovery actions and cannot be exported as a successful file.
- At mobile width, the empty-state chooser and Add RAW action are visible before any processing controls or export action.
- The built-in LUT manifest contains only verified source files with matching SHA-256 hashes.
