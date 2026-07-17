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
- The sparse parity defect test starts with a second defect that is not an
  initial candidate and proves that correcting its dependency schedules it at
  the exact later row-order position.
- The LibRaw isolated-direction test uses adjacent direction choices whose
  refinements cascade, verifies the row-ordered in-place result, and checks the
  packed four-bit plane emitted by the same scan.
- Tiled output matches the corresponding accepted full-frame output exactly,
  while the full-frame output is independently checked against LibRaw or the
  explicitly approved candidate CPU reference.
- The 1024-core, 12-halo tiled parity route compares all 78,024,960 Sony output
  channels with the pinned LibRaw oracle in one cold and four warm runs, while
  reporting peak buffer allocation and maximum binding size.
- A hardware synthetic dependency fixture crosses horizontal and vertical tile
  seams, uses rectangular edge tiles and clustered extreme defects, and
  bit-matches full-frame output for all four Bayer phases; a smaller-than-tile
  fixture covers the single-tile path and a separate fixture proves unequal
  per-channel black-level scaling.
- WebGPU exposure and LUT output compares against the current Rust corrected-v2
  CPU/WASM renderer for the same ProPhoto input and rejects any sample more than
  two code values away.
- Complete export correctness compares every decoded RGB16 TIFF sample with the
  current production browser/native CLI export; compressed TIFF byte identity
  is not used as the image-quality criterion.
- The experimental browser export keeps AAHD and corrected-v2 color/LUT work on
  one WebGPU device, streams final row bands through two bounded output
  readbacks, and rejects unsupported input without falling back to LibRaw.
- One cold and four warm complete experimental exports report TIFF encoding,
  Worker wall time, every AAHD stage, peak GPU allocation, and maximum binding;
  the decoded Sony TIFF rejects any channel difference above two codes.
- A second-camera hardware export compares every Leica M8 TIFF channel with
  production LibRaw, exercises LibRaw's adjusted processing maximum, and
  rejects any difference above two codes.
- Production Preview interaction benchmarks remain authoritative for first
  feedback: they cover 20 EV edits, cold and warm LUT changes, continuous input,
  and UI responsiveness while RAW decode is active.
- The horizontal and vertical candidate comparisons check every RGB channel value and report counts, thresholds, maximum location, MAE, RMSE, and PSNR.
- The direction comparison expands each captured direction to three channels and proves that the selected-candidate mismatch is independently measurable from candidate interpolation.
- The selected-AAHD and final-ProPhoto comparisons check all 78,024,960 RGB16 channel values on the Sony fixture.
- The LibRaw-parity YUV comparison checks every signed 16-bit component before
  homogeneity selection, and the WGSL parity path stores each matrix operation
  through `f32` storage within one dispatch to preserve LibRaw's
  statement-level rounding.
- The compact highlight test proves the scalar Blend transform against a known
  LibRaw pixel, then verifies all 49,408 collected Sony pixels and the complete
  78,024,960-channel highlight boundary exactly before ProPhoto conversion.
- The hardware benchmark records one cold and at least four warm runs, verifies a non-fallback NVIDIA WebGPU adapter, and reports every GPU phase plus LibRaw unpack and worker totals.
- The LibRaw algorithm benchmark can select AAHD alone and reports warm distribution statistics for the production CPU/WASM baseline.
- The normal unit, production build, native workspace, and browser end-to-end suites continue to exercise the unchanged production path; the prototype remains query-gated.
- Changing the default decoder requires a broader camera and client-GPU matrix;
  the experimental suite already covers two Bayer cameras, tile borders,
  clipped Blend highlights, every Bayer phase, unequal black levels, and
  clustered defect cascades.
