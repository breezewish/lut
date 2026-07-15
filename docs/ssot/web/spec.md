# Web Specification

## Local workflow

The browser accepts multiple RAW files through a chooser or drag and drop. Duplicate selections are ignored by file identity. The first selected file begins decoding. A JPEG thumbnail embedded by the camera is labeled and displayed before the processed preview when available.

The selected file has side-by-side Base and LUT previews. Changing EV or LUT rerenders the cached preview without decoding RAW again. Look selection supports text search and recent choices. EV supports a slider and bounded numeric entry. The queue shows textual status, camera, dimensions, removal, clear, and undo.

Export selected downloads one TIFF. Export all processes nonfailed queue entries serially and downloads one ZIP. It reports the current file and position, can stop after the current file, continues past per-file failures, and leaves a completion or partial-success summary. A corrupt file displays product-language recovery actions, disables its selected export, and is skipped by batch export.

If the local WASM processing engine cannot initialize, the active request fails with a visible reload instruction instead of remaining in a decoding state.

## Interface

The workspace is flat, borderless, shadowless, dark, and responsive. Image comparison is visually dominant. Processing controls are hidden before a file is selected. The task order is edit, compare, then export in both DOM and visual flow. Every interactive target is at least 44 px. Side-by-side comparison remains until the viewport is narrower than 35rem. When the complete workspace is taller than a short viewport, the page scrolls so export remains reachable. Reduced-motion preferences are honored.

## Privacy and assumptions

RAW and decoded data stay in the browser worker. The application fetches only its own static code and built-in LUT assets. The UI states that files stay on the device and that LUT output color semantics are undocumented.
