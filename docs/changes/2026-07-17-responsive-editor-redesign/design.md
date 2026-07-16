# Responsive Editor Redesign

## Interaction

The exposure range remains an uncontrolled native input during pointer movement. The handler updates its visual progress, numeric readout, and accessibility value directly, invalidates export readiness on the first event, and retains only the latest requested value. Every 50 ms, an interruptible React transition commits that value to preview state. This separates continuous input painting from application reconciliation and bounds Worker demand without changing the final recipe.

Committed exposure edits render an exact-color 256px interaction frame. After 120 ms idle, the current recipe renders at 1024px and becomes export-ready. The existing one-active plus one-latest Worker queue remains the only processing scheduler.

## Presentation

The application uses neutral, slightly blue-biased OKLCH surfaces so preview color remains dominant. Spectral blue carries selection, focus, active range, and primary actions. Desktop chrome is deliberately dense: a 48px toolbar, compact rails, 30–36px controls, and 6px radii. Coarse-pointer media expands action targets to 44px. Surfaces are separated by value, not borders or shadows.

## Performance fixture

The opt-in large interaction benchmark downloads the CC0 Sony ILCE-7RM4 14-bit compressed RAW from raw.pixls.us to `/tmp`, verifies its SHA-256, and never adds it to Git. The decoded 9568 × 6376 image is dragged during active decode under 4× CPU throttling.
