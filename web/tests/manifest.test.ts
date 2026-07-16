import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("creative LUT manifest is complete, unique, and tied to source bytes", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(
    await readFile(join(root, "assets/luts.json"), "utf8"),
  );
  expect(manifest.source.commit).toBe(
    "a0d9aae0dc2d2ed04631960879519a5366245877",
  );
  expect(manifest.contract.outputStatus).toBe("unverified");
  expect(manifest.luts).toHaveLength(27);
  expect(new Set(manifest.luts.map((lut: { id: string }) => lut.id)).size).toBe(
    27,
  );

  for (const lut of manifest.luts) {
    expect(lut.file).not.toContain("Panasonic-Standard");
    const bytes = await readFile(
      join(root, "vendor/V-Log-Alchemy/Luts", lut.file),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(lut.sha256);
  }
});

test("legacy fixture bytes match the frozen source manifest", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const baselineRoot = join(root, "baselines/legacy-python-v1");
  const manifest = JSON.parse(
    await readFile(join(baselineRoot, "manifest.json"), "utf8"),
  );
  const fixture = await readFile(join(baselineRoot, manifest.fixture.path));
  const raw = await readFile(join(root, manifest.sources.raw.path));

  expect(manifest.sources.rawAlchemyCommit).toBe(
    "10d4f5bded68d75d4db87cfeeddec1e5fea297d5",
  );
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    manifest.sources.raw.sha256,
  );
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    manifest.fixture.sha256,
  );
  expect(manifest.fixture.sha256).toBe(
    "b203ef0103c8f4b5d5f799f8fe89b5cecfb07bbce58e228dd48932ef28b2dce4",
  );
});
