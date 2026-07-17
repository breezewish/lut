import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(
    join(root, "tests/fixtures/webgpu-camera-matrix.json"),
    "utf8",
  ),
);
const fixtureRoot = resolve(
  process.env.WEBGPU_CAMERA_FIXTURE_DIR ??
    join(root, "tests/fixtures/webgpu-camera-matrix"),
);

await mkdir(fixtureRoot, { recursive: true });
for (const fixture of manifest.fixtures) {
  if (fixture.file !== basename(fixture.file)) {
    throw new Error(`Fixture ${fixture.id} has an invalid file name.`);
  }
  const path = join(fixtureRoot, fixture.file);
  if (await matchesFixture(path, fixture)) {
    console.log(`${fixture.camera} fixture ready: ${path}`);
    continue;
  }
  await rm(path, { force: true });
  await downloadFixture(path, fixture);
  console.log(`${fixture.camera} fixture ready: ${path}`);
}

async function matchesFixture(path, fixture) {
  try {
    const metadata = await stat(path);
    return (
      metadata.size === fixture.bytes &&
      (await sha256File(path)) === fixture.sha256
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function downloadFixture(path, fixture) {
  const temporaryPath = `${path}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await rm(temporaryPath, { force: true });
    try {
      const response = await fetch(fixture.source);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const hash = createHash("sha256");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
      const actualSha256 = hash.digest("hex");
      if (bytes !== fixture.bytes || actualSha256 !== fixture.sha256) {
        throw new Error(
          `received ${bytes} bytes with SHA-256 ${actualSha256}; expected ${fixture.bytes} bytes with SHA-256 ${fixture.sha256}`,
        );
      }
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true });
      if (attempt < 5) {
        console.warn(
          `Could not download ${fixture.camera} fixture (attempt ${attempt}/5): ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  throw new Error(
    `Could not prepare ${fixture.camera} fixture after 5 attempts: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
