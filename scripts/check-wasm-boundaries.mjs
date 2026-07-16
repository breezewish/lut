import { readFile } from "node:fs/promises";

const [binding, worker, browserWrapper, previewCanvas] = await Promise.all([
  readFile("web/src/wasm/alchemy_core.js", "utf8"),
  readFile("web/src/workers/processing.worker.ts", "utf8"),
  readFile("crates/alchemy-libraw/src/browser_wrapper.cpp", "utf8"),
  readFile("web/src/components/preview-canvas.tsx", "utf8"),
]);

function methodBody(signature) {
  const start = binding.indexOf(signature);
  if (start === -1) throw new Error(`Missing generated method: ${signature}`);
  const open = binding.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < binding.length; index += 1) {
    if (binding[index] === "{") depth += 1;
    if (binding[index] === "}") depth -= 1;
    if (depth === 0) return binding.slice(open + 1, index);
  }
  throw new Error(`Unterminated generated method: ${signature}`);
}

const previewConstructor = methodBody(
  "create_preview_renderer(source_width, source_height, max_edge)",
);
const lutWrite = methodBody("write_word(offset, word, length)");
const previewWrite = methodBody("write_source_row(pixels)");
const previewRender = methodBody("render(ev)");
const tiffConstructor = methodBody("create_tiff_encoder(width, height, ev)");
const tiffRender = methodBody("render_strip(pixels)");
const tiffWrite = methodBody("write_strip()");

if (lutWrite.includes("passArray8ToWasm0")) {
  throw new Error(
    "LUT upload unexpectedly copies bytes through a bulk binding.",
  );
}
if (
  previewConstructor.includes("passArray8ToWasm0") ||
  tiffConstructor.includes("passArray8ToWasm0")
) {
  throw new Error(
    "Preview or TIFF construction unexpectedly copies a complete CUBE document.",
  );
}
if (previewConstructor.includes("passArray16ToWasm0")) {
  throw new Error(
    "Preview constructor unexpectedly copies the complete RGB16 source image.",
  );
}
if (!previewWrite.includes("passArray16ToWasm0(pixels")) {
  throw new Error("Preview renderer no longer receives bounded RGB16 rows.");
}
if (previewRender.includes("passArray16ToWasm0")) {
  throw new Error(
    "Preview rerender unexpectedly copies an RGB16 source image.",
  );
}
if (previewRender.includes("passStringToWasm0")) {
  throw new Error("Preview EV rerender unexpectedly reparses the current LUT.");
}
if (!tiffRender.includes("passArray16ToWasm0(pixels")) {
  throw new Error(
    "TIFF strip renderer no longer receives bounded RGB16 views.",
  );
}
if (tiffWrite.includes("passArray16ToWasm0")) {
  throw new Error("TIFF Deflate unexpectedly copies another RGB16 strip.");
}
if (binding.includes("export function render_tiff(")) {
  throw new Error("The whole-image TIFF WASM binding must not be exported.");
}

if (worker.includes(".imageData(")) {
  throw new Error(
    "The Worker must not request a complete JavaScript RGB16 copy.",
  );
}
if (!worker.includes(".imageView(")) {
  throw new Error("The Worker no longer reads bounded LibRaw RGB16 views.");
}
if (
  !worker.includes("LUT_UPLOAD_WORD_BYTES = 4") ||
  !worker.includes("words.getUint32(offset, true)") ||
  !worker.includes("parsed.write_word(offset")
) {
  throw new Error(
    "The Worker no longer uploads verified LUTs through scalar WASM words.",
  );
}
if (
  !worker.includes('data.type === "clear"') ||
  !worker.includes("cached?.renderer.free()")
) {
  throw new Error("Removing the active RAW no longer frees its preview cache.");
}
const imageViewStart = browserWrapper.indexOf("val image_view(");
const imageViewEnd = browserWrapper.indexOf("\nprivate:", imageViewStart);
const imageView = browserWrapper.slice(imageViewStart, imageViewEnd);
if (imageViewStart === -1 || imageViewEnd === -1) {
  throw new Error("Missing browser LibRaw image_view implementation.");
}
if (!imageView.includes("typed_memory_view(length, pixels + offset)")) {
  throw new Error("LibRaw image_view no longer returns the bounded WASM view.");
}
if (imageView.includes("new_(") || imageView.includes('call<void>("set"')) {
  throw new Error(
    "LibRaw image_view unexpectedly copies RGB16 into JavaScript.",
  );
}
if (
  !previewCanvas.includes("pixels.buffer") ||
  previewCanvas.includes("clamped.set(pixels)")
) {
  throw new Error(
    "Canvas rendering must reinterpret transferred RGBA8 without another complete preview copy.",
  );
}

console.log(
  "Verified zero-copy LibRaw and Canvas views, row-only preview, and strip-only TIFF WASM bindings.",
);
