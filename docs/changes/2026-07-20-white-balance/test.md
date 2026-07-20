# Relative White Balance Tests

- Temperature and Tint matrix samples match frozen Raw Alchemy Studio output within `1e-6`, including both axes, corners, and mixed values.
- Zero Temperature and Tint preserve the previous As Shot corrected-v2 oracle output.
- Browser recipe commands carry white balance through decode, Preview rerender, Look thumbnails, and export.
- Continuous colored-slider input invalidates export, renders a 256px WebGPU interaction frame, and enables export only after the exact 1024px recipe settles.
- Multi-selection applies both axes to every selected photo, reports mixed values, and resets both axes together.
- SwiftShader exports nonzero Temperature and Tint through production WebGPU and matches native Rust TIFF output within the existing six-code ceiling.
- A short desktop and a narrow touch viewport keep comparison and Output usable with the added compact panel.
