import { readFile } from "node:fs/promises";

const binding = await readFile("web/src/wasm/alchemy_core.js", "utf8");

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

console.log("Verified row-only preview and strip-only TIFF WASM bindings.");
