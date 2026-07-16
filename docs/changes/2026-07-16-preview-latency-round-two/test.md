# Preview Latency Round Two Tests

- The production Chromium initial-Preview benchmark enforces the tighter cold and warm 384px and 1024px Canvas budgets while recording LibRaw phase timings, then validates one independent full export after Preview sampling so export memory pressure cannot contaminate warm Preview measurements.
- The production Chromium interaction benchmark enforces isolated EV, first-use LUT, cached LUT, and continuous 60 Hz EV budgets from control input through Canvas publication.
- A continuous EV burst publishes only monotonically newer same-file and same-LUT interaction generations, rejects older editing contexts, and ends on the exact current 1024px recipe before enabling export.
- The quality verifier compares display-sized Preview with full export for linear DNG, lossy linear DNG, Leica Bayer DNG, rotated Leica Bayer DNG, Sony Bayer ARW, and Fujifilm X-Trans RAF, while legacy diagonal Fuji fails explicitly.
- Native/WASM parity proves that full-resolution export remains unchanged, and browser failure tests prove that Preview pixels are never used as an export source.
- Chromium, Firefox, WebKit, and repository-subpath production tests cover the changed runtime boundary.
