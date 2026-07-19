# Preview Cache Performance

## Introduction

Photo switching must preserve the user's editing flow instead of behaving like a new import.

## Requirements

- The six most recently used photos retain their decoded preview sources; the three most recent retain UI comparison buffers and Look thumbnails.
- Returning to a GPU-retained photo never rereads or decodes the RAW. UI-retained photos restore their exact EV, Look, comparison, and Look thumbnails immediately.
- Continuous EV changes render Worker-created longest-edge-256 bitmaps with latest-only backpressure, then refine once at 1024 after settling.
- LUT changes render a Worker-created longest-edge-256 Look bitmap before the 1024px Look bitmap and never resend the unchanged Base pane.
- Changing EV retains the previous tiles and regenerates every Look thumbnail for the active photo in one interruptible, progressively replacing batch.
- Look thumbnails remain display-sized and never reuse the 1024px comparison buffers.
- Compressed GPU-demosaic inputs may retain sensor mosaics under one 64 MiB queue-wide budget without reducing the six-photo GPU source cache.
- Removing a photo releases only that photo's resources; clearing the queue releases all preview and sensor resources.
- Camera and dimensions appear with the active document.
- Output contains only the export action; progress uses the action and completion uses a toast.
- The filmstrip has no redundant photo-count label.

## Non-goals

- Full-resolution RGB output is never cached.
- The preview cache is not persistent across page reloads.
