# LibRaw AAHD WebGPU Prototype Tests

- The LibRaw oracle captures the exact scaled CFA, both AAHD candidates, refined direction flags, selected camera RGB, final ProPhoto RGB16, matrices, extrema, and scale parameters from the pinned production configuration.
- The horizontal and vertical candidate comparisons check every RGB channel value and report counts, thresholds, maximum location, MAE, RMSE, and PSNR.
- The direction comparison expands each captured direction to three channels and proves that the selected-candidate mismatch is independently measurable from candidate interpolation.
- The selected-AAHD and final-ProPhoto comparisons check all 78,024,960 RGB16 channel values on the Sony fixture.
- The hardware benchmark records one cold and at least four warm runs, verifies a non-fallback NVIDIA WebGPU adapter, and reports every GPU phase plus LibRaw unpack and worker totals.
- The LibRaw algorithm benchmark can select AAHD alone and reports warm distribution statistics for the production CPU/WASM baseline.
- The normal unit, production build, native workspace, and browser end-to-end suites continue to exercise the unchanged production path; the prototype remains query-gated.
- A production follow-up must add multi-camera, border, clipped-highlight, CFA-phase, unequal-black-level, and synthetic clustered-defect cases before changing the product decoder.
