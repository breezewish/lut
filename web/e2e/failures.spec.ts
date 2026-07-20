import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const linearFixture = resolve("tests/fixtures/linear.dng");

test("export waits until the selected preview matches the visible recipe", async ({
  page,
}) => {
  const bytes = await readFile(linearFixture);
  let releaseLut!: () => void;
  const lutGate = new Promise<void>((resolveGate) => {
    releaseLut = resolveGate;
  });
  await page.route("**/*.ralut*", async (route) => {
    await lutGate;
    await route.continue();
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "selected.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "queued.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
  ]);

  const exportSelected = page.getByRole("button", {
    name: "Export selected as TIFF",
  });
  await expect(exportSelected).toBeDisabled();

  releaseLut();
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await expect(exportSelected).toBeEnabled();
});

test("a mismatched LUT fails explicitly and the RAW can be retried", async ({
  page,
}) => {
  await page.route("**/*.ralut*", (route) =>
    route.fulfill({ contentType: "text/plain", body: "tampered LUT" }),
  );
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "LUT integrity check failed: NC | Classic Neg.",
  );
  await expect(
    page.getByRole("button", { name: "Export selected as TIFF" }),
  ).toBeDisabled();
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);

  await page.unroute("**/*.ralut*");
  await page.getByRole("button", { name: "Remove file" }).click();
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
});

test("a missing LUT fails without leaving the RAW in decoding", async ({
  page,
}) => {
  await page.route("**/*.ralut*", (route) => route.fulfill({ status: 404 }));
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "Could not load LUT: NC | Classic Neg.",
  );
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export selected as TIFF" }),
  ).toBeDisabled();
});

test("a hash-valid malformed compact LUT reports its parser error", async ({
  page,
}) => {
  const malformed = Buffer.alloc(36);
  malformed.write("RALUT01\0", 0, "ascii");
  malformed.writeUInt32LE(2, 8);
  malformed.writeFloatLE(1, 24);
  malformed.writeFloatLE(1, 28);
  malformed.writeFloatLE(1, 32);
  const manifest = JSON.parse(
    await readFile(resolve("web/public/luts/manifest.json"), "utf8"),
  ) as {
    luts: Array<{ id: string; sha256: string }>;
  };
  manifest.luts.find((lut) => lut.id === "fuji-classic-negative")!.sha256 =
    createHash("sha256").update(malformed).digest("hex");
  await page.route("**/luts/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", json: manifest }),
  );
  await page.route("**/*.ralut*", (route) =>
    route.fulfill({ contentType: "application/octet-stream", body: malformed }),
  );
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "CUBE declares 0 samples; expected 8",
  );
  await expect(
    page.getByRole("button", { name: "Export selected as TIFF" }),
  ).toBeDisabled();
});

test("an invalid manifest keeps an imported RAW out of the fake preview state", async ({
  page,
}) => {
  await page.route("**/luts/manifest.json", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "The built-in LUT manifest could not be loaded.",
  );
  await expect(
    page.getByRole("region", { name: "Processing controls" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Built-in looks unavailable. Reload to retry." }),
  ).toBeVisible();
  await expect(page.getByLabel("Base preview")).toHaveCount(0);
  await expect(page.getByLabel("LUT preview")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /linear\.dng.*Queued/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
