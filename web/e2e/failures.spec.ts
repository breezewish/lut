import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const linearFixture = resolve("tests/fixtures/linear.dng");

test("a mismatched LUT fails explicitly and the RAW can be retried", async ({
  page,
}) => {
  await page.route("**/*.cube", (route) =>
    route.fulfill({ contentType: "text/plain", body: "tampered LUT" }),
  );
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "LUT integrity check failed for Classic Negative.",
  );
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeDisabled();
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);

  await page.unroute("**/*.cube");
  await page.getByRole("button", { name: "Remove file" }).click();
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
});

test("a missing LUT fails without leaving the RAW in decoding", async ({
  page,
}) => {
  await page.route("**/*.cube", (route) => route.fulfill({ status: 404 }));
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "Could not load LUT Classic Negative.",
  );
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export selected" }),
  ).toBeDisabled();
});

test("a hash-valid malformed CUBE reports its parser error", async ({
  page,
}) => {
  const malformed = "LUT_3D_SIZE 2\n0 0 0\n";
  const manifest = JSON.parse(
    await readFile(resolve("assets/luts.json"), "utf8"),
  ) as {
    luts: Array<{ id: string; sha256: string }>;
  };
  manifest.luts.find((lut) => lut.id === "fuji-classic-negative")!.sha256 =
    createHash("sha256").update(malformed).digest("hex");
  await page.route("**/luts/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", json: manifest }),
  );
  await page.route("**/*.cube", (route) =>
    route.fulfill({ contentType: "text/plain", body: malformed }),
  );
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "CUBE declares 1 samples; expected 8",
  );
  await expect(
    page.getByRole("button", { name: "Export selected" }),
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
    page.getByRole("heading", { name: "Built-in looks unavailable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Base preview")).toHaveCount(0);
  await expect(page.getByLabel("LUT preview")).toHaveCount(0);
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
