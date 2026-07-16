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
