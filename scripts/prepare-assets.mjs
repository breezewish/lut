import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "assets/luts.json");
const sourceRoot = join(root, "vendor/V-Log-Alchemy/Luts");
const outputRoot = join(root, "web/public/luts");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const runtimeManifest = structuredClone(manifest);

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
  ...manifest.luts.map((lut) => `${lut.id}.ralut`),
]);

for (const [index, lut] of manifest.luts.entries()) {
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
  const binary = encodeLut(bytes.toString("utf8"), lut.file);
  const runtimeLut = runtimeManifest.luts[index];
  runtimeLut.file = `${lut.id}.ralut`;
  runtimeLut.sha256 = createHash("sha256").update(binary).digest("hex");
  await writeIfChanged(join(outputRoot, runtimeLut.file), binary);
}

await writeIfChanged(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
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

function encodeLut(source, file) {
  let size;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let hasDomainMin = false;
  let hasDomainMax = false;
  const samples = [];
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("TITLE ")) continue;
    const fields = line.split(/\s+/u);
    if (fields[0] === "LUT_3D_SIZE") {
      if (size !== undefined || fields.length !== 2) {
        throw new Error(`Invalid LUT_3D_SIZE in ${file}:${index + 1}`);
      }
      size = Number(fields[1]);
      continue;
    }
    if (fields[0] === "DOMAIN_MIN" || fields[0] === "DOMAIN_MAX") {
      const isMinimum = fields[0] === "DOMAIN_MIN";
      if ((isMinimum && hasDomainMin) || (!isMinimum && hasDomainMax)) {
        throw new Error(`Duplicate ${fields[0]} in ${file}:${index + 1}`);
      }
      const values = parseTriplet(fields.slice(1), file, index + 1);
      if (isMinimum) {
        domainMin = values;
        hasDomainMin = true;
      } else {
        domainMax = values;
        hasDomainMax = true;
      }
      continue;
    }
    if (fields[0].startsWith("LUT_")) {
      throw new Error(`Unsupported LUT directive in ${file}:${index + 1}`);
    }
    samples.push(parseTriplet(fields, file, index + 1));
  }
  if (!Number.isInteger(size) || size < 2 || size > 129) {
    throw new Error(`Invalid LUT size in ${file}`);
  }
  if (samples.length !== size ** 3) {
    throw new Error(`Invalid LUT sample count in ${file}`);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (domainMax[axis] <= domainMin[axis]) {
      throw new Error(`Invalid LUT domain in ${file}`);
    }
  }

  const binary = Buffer.alloc(36 + samples.length * 12);
  binary.write("RALUT01\0", 0, "ascii");
  binary.writeUInt32LE(size, 8);
  [...domainMin, ...domainMax].forEach((value, index) =>
    binary.writeFloatLE(value, 12 + index * 4),
  );
  for (const [sampleIndex, sample] of samples.entries()) {
    sample.forEach((value, channel) =>
      binary.writeFloatLE(value, 36 + sampleIndex * 12 + channel * 4),
    );
  }
  return binary;
}

function parseTriplet(fields, file, line) {
  if (fields.length !== 3) {
    throw new Error(`Expected three LUT values in ${file}:${line}`);
  }
  const values = fields.map(Number);
  if (!values.every(Number.isFinite)) {
    throw new Error(`Invalid LUT value in ${file}:${line}`);
  }
  return values;
}
