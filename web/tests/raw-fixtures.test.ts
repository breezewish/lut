import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "vitest";

test("RAW fixtures retain their declared provenance and decoder roles", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    await readFile(resolve(root, "tests/fixtures/raw-manifest.json"), "utf8"),
  ) as {
    fixtures: Array<{
      id: string;
      path: string;
      kind: string;
      sha256: string;
      source?: string;
      license?: string;
    }>;
  };

  expect(manifest.fixtures.map((fixture) => fixture.kind)).toEqual([
    "synthetic-linear-dng",
    "synthetic-lossy-linear-dng",
    "real-camera-cfa-dng",
    "real-camera-arw",
  ]);
  const realDng = manifest.fixtures.find(
    (fixture) => fixture.id === "leica-m8-cfa-dng",
  );
  expect(realDng).toMatchObject({
    source: "https://raw.pixls.us/data/Leica/M8/L1030132.DNG",
    license: "CC0-1.0",
  });

  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(resolve(root, fixture.path));
    expect(createHash("sha256").update(bytes).digest("hex"), fixture.id).toBe(
      fixture.sha256,
    );
  }
});

test("downloadable WebGPU camera fixtures remain a pinned sensor matrix", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    await readFile(
      resolve(root, "tests/fixtures/webgpu-camera-matrix.json"),
      "utf8",
    ),
  ) as {
    version: number;
    fixtures: Array<{
      id: string;
      file: string;
      source: string;
      sha256: string;
      bytes: number;
      license: string;
      camera: string;
      mode: string;
      width: number;
      height: number;
    }>;
  };

  expect(manifest.version).toBe(1);
  expect(
    manifest.fixtures.map(({ camera, mode }) => ({ camera, mode })),
  ).toEqual([
    { camera: "Nikon Z 6", mode: "14-bit lossless compressed" },
    { camera: "Panasonic DC-GH5", mode: "12-bit 4:3" },
    { camera: "Fujifilm X-A5", mode: "14-bit uncompressed Bayer" },
    {
      camera: "Fujifilm X-T2",
      mode: "14-bit lossless compressed X-Trans",
    },
  ]);
  for (const fixture of manifest.fixtures) {
    expect(new URL(fixture.source).origin, fixture.id).toBe(
      "https://raw.pixls.us",
    );
    expect(fixture.sha256, fixture.id).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.bytes, fixture.id).toBeGreaterThan(20_000_000);
    expect(fixture.license, fixture.id).toBe("CC0-1.0");
    expect(fixture.width * fixture.height, fixture.id).toBeGreaterThan(
      20_000_000,
    );
  }
});
