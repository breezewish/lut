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
