import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "assets/luts.json");
const sourceRoot = join(root, "vendor/V-Log-Alchemy/Luts");
const outputRoot = join(root, "web/public/luts");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const lut of manifest.luts) {
  if (lut.file.includes("Panasonic-Standard")) {
    throw new Error(
      `Standard adapter is not a creative V-Log look: ${lut.file}`,
    );
  }
  const source = join(sourceRoot, lut.file);
  const bytes = await readFile(source);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== lut.sha256) {
    throw new Error(`LUT hash mismatch for ${lut.file}: ${actual}`);
  }
  const destination = join(outputRoot, lut.file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

await writeFile(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Prepared and verified ${manifest.luts.length} V-Log LUTs.`);
