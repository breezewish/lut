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
  "constructor(source_width, source_height, max_edge, cube)",
);
const previewWrite = methodBody("write_source_row(pixels)");
const previewRender = methodBody("render(ev)");
const tiffWrite = methodBody("write_strip(pixels)");

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
if (!tiffWrite.includes("passArray16ToWasm0(pixels")) {
  throw new Error("TIFF strip writer no longer receives bounded RGB16 views.");
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
