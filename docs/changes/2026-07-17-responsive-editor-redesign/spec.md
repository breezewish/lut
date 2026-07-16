# Responsive Editor Redesign

## Goal

Exposure interaction must remain responsive while large RAW decode and preview computation are active. The workspace must also use a visibly new, compact visual system rather than inherited browser or generic component styling.

## Requirements

- Native exposure input paints independently of preview computation.
- Continuous input cannot synchronously reconcile the complete application for every browser event.
- A checksum-verified RAW above 33 million pixels is exercised while decode and drag overlap under constrained CPU.
- Dark and Light modes use neutral surfaces, spectral-blue active states, compact controls, and no decorative borders or shadows.
- Desktop actions use 32–36 px bodies; coarse-pointer actions remain at least 44 px.
- Search, look selection, numeric EV, range, menu, queue selection, and export actions share one authored interaction vocabulary.
