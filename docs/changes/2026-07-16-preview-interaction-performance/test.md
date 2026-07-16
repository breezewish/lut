# Preview Interaction Performance Tests

- Twenty EV changes in the production Chromium bundle meet the first-frame and settled-frame p95 budgets after the Sony reference RAW is ready.
- First selection of every built-in LUT meets the cross-LUT settled-frame p95 budget and records asset-load and color-render stages.
- Twenty switches between parsed LUTs meet the cached first-frame budget and prove session reuse.
- Progressive rendering paints exact-color 384px interaction frames and 1024px settled frames in order, while export becomes available only for the settled current recipe.
- Compact LUT, preview transfer-table, browser/native parity, and real-RAW tests preserve the documented numerical error bounds.
