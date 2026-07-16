import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "assets/luts.json");
const sourceRoot = join(root, "vendor/V-Log-Alchemy/Luts");
const outputRoot = join(root, "web/public/luts");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

async function writeIfChanged(path, bytes) {
  const expected = Buffer.from(bytes);
  try {
    if ((await readFile(path)).equals(expected)) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(path, expected);
}

await mkdir(outputRoot, { recursive: true });

const expectedFiles = new Set([
  "manifest.json",
  ...manifest.luts.map((lut) => lut.file),
]);

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
  await writeIfChanged(destination, bytes);
}

await writeIfChanged(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// Keep existing public files in place while Vite is running. Removing the
// whole directory makes Vite forget every LUT URL until the dev server is
// restarted, even when the files are recreated immediately afterward.
const outputEntries = await readdir(outputRoot, {
  recursive: true,
  withFileTypes: true,
});
for (const entry of outputEntries) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  if (!expectedFiles.has(relative(outputRoot, path))) {
    await rm(path);
  }
}
console.log(`Prepared and verified ${manifest.luts.length} V-Log LUTs.`);
