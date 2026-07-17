# WebGPU Preview Tests

- A hardware WebGPU test uses a non-fallback T4 adapter, renders the first exposure response at longest-edge 1024, and compares every Base sample and every built-in Look's RGBA8 samples with the CPU renderer within one code.
- The production benchmark measures 20 EV changes, every cold built-in LUT, 20 warm LUT changes, and records Worker GPU execution plus readback timings.
- A nominal 60-event EV burst paints at least 30 full-detail frames and meets the first and final latency budgets without a coarse phase.
- Cold and warm initial RAW processing still meet the embedded JPEG, 384px processed, and 1024px settled boundaries.
- Unit tests preserve one-active-plus-latest render coalescing, explicit WebGPU selection fields, CPU progressive rendering, and one-time source ownership transfer.
