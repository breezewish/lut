# Automatic Exposure Baseline

## Introduction

RAW files normalized by LibRaw do not carry a useful display brightness. Requiring users to add several EV before every LUT comparison makes the default result misleading and repeats work across photos.

## Goals

- Establish one useful scene-derived exposure baseline for each photo.
- Keep the visible EV control as a relative creative adjustment.
- Apply the same effective exposure to Base, LUT previews, Look thumbnails, and export.
- Keep decode, rerender, photo switching, and export GPU-first and responsive.

## Non-goals

- Reconstruct capture exposure from aperture, shutter speed, or ISO metadata.
- Add automatic exposure to the CLI; its EV remains explicit.
- Add a CPU browser fallback.

## Product behavior

The first processed preview meters the linear photo without exposing that internal baseline. EV starts at zero against the metered result. Reset restores EV to zero without recomputing the baseline.

Changing EV or LUT reuses the cached baseline. Switching back to a retained photo restores it immediately. Export uses the same baseline. If a queued photo has not yet been previewed, export meters one display-sized source before processing the full-resolution image.
