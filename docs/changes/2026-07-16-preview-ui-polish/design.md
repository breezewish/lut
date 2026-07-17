# Preview UI Polish Design

## Introduction

The preview viewport is layout state, while progressive buffers are render state. Separating them removes visual jumps. The adjustment inspector exposes render state from the existing exact recipe contract.

## Detailed Design

Each preview Canvas fills its stable image well and contains its pixel buffer without using intrinsic dimensions for CSS layout. The processing indicator is derived from selected-file validity, preview usability, and exact equality between visible and rendered recipe keys.

Form controls use shared theme tokens for default, hover, focus, active, and disabled states. Search includes a leading icon, look selection exposes a restrained selection marker, numeric EV removes browser steppers, and the range uses a semantic filled track.

## Trade-offs

Scaling the fast preview to the final viewport makes its lower resolution visible for a short period, but preserves spatial continuity and communicates progressive refinement honestly.

## Test Plan

Browser tests record Canvas CSS and pixel dimensions across progressive frames and delay EV/LUT renders to verify the processing indicator lifecycle. Existing theme, responsive, preview, and export tests cover regression risk.

## Open Questions

None.
