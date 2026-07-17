# LibRaw AAHD WebGPU Prototype Tests

- The product correctness baseline is the current pinned LibRaw AAHD pipeline,
  followed by the Rust corrected-v2 color/LUT pipeline; Studio and ONNX outputs
  are not correctness references, and the Python float64 oracle covers only the
  corrected-v2 color/LUT layer.
- The LibRaw oracle captures the exact scaled CFA, both AAHD candidates, refined direction flags, selected camera RGB, final ProPhoto RGB16, matrices, extrema, and scale parameters from the pinned production configuration.
- The LibRaw oracle also captures pre-refinement homogeneity and chosen
  directions plus the post-Blend, pre-ProPhoto RGB boundary so numerical
  divergence is isolated before it affects a later discrete or matrix stage.
- A LibRaw-parity implementation matches every captured integer AAHD boundary
  exactly and may propose at most a one-code-value final ProPhoto tolerance only
  when every nonzero floating-point difference is explicitly reported.
- A deterministic parallel defect implementation compares every affected AAHD
  boundary with an independent scalar CPU implementation of that new policy;
  this proves the candidate implementation, not compatibility with the product
  baseline, and cannot replace the golden without explicit approval.
- The immutable defect test uses adjacent defects whose classifications would
  cascade under in-place writes and verifies the corrected samples and packed
  defect mask against the original mosaic.
- The isolated-direction test uses adjacent direction choices whose refinements
  would cascade under in-place writes and verifies every result against one
  immutable input plane.
- Tiled output matches the corresponding accepted full-frame output exactly,
  while the full-frame output is independently checked against LibRaw or the
  explicitly approved candidate CPU reference.
- WebGPU exposure and LUT output compares against the current Rust corrected-v2
  CPU/WASM renderer for the same ProPhoto input and rejects any sample more than
  two code values away.
- Complete export correctness compares every decoded RGB16 TIFF sample with the
  current production browser/native CLI export; compressed TIFF byte identity
  is not used as the image-quality criterion.
- The horizontal and vertical candidate comparisons check every RGB channel value and report counts, thresholds, maximum location, MAE, RMSE, and PSNR.
- The direction comparison expands each captured direction to three channels and proves that the selected-candidate mismatch is independently measurable from candidate interpolation.
- The selected-AAHD and final-ProPhoto comparisons check all 78,024,960 RGB16 channel values on the Sony fixture.
- The LibRaw-parity YUV comparison checks every signed 16-bit component before
  homogeneity selection, and the WGSL parity path stores each matrix operation
  through `f32` storage to preserve LibRaw's statement-level rounding.
- The compact highlight test proves the scalar Blend transform against a known
  LibRaw pixel, then verifies all 49,408 collected Sony pixels and the complete
  78,024,960-channel highlight boundary exactly before ProPhoto conversion.
- The hardware benchmark records one cold and at least four warm runs, verifies a non-fallback NVIDIA WebGPU adapter, and reports every GPU phase plus LibRaw unpack and worker totals.
- The LibRaw algorithm benchmark can select AAHD alone and reports warm distribution statistics for the production CPU/WASM baseline.
- The normal unit, production build, native workspace, and browser end-to-end suites continue to exercise the unchanged production path; the prototype remains query-gated.
- A production follow-up must add multi-camera, border, clipped-highlight, CFA-phase, unequal-black-level, and synthetic clustered-defect cases before changing the product decoder.
