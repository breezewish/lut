import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { decodeRgb16Tiff } from "./tiff";

const linearFixture = resolve("tests/fixtures/linear.dng");

test("imports, previews, and exports from the HTTPS production bundle", async ({
  page,
}) => {
  await page.goto("/");
  expect(await page.evaluate(() => isSecureContext)).toBe(true);
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected" }).click();
  const download = await downloadPromise;
  const outputPath = await download.path();
  expect(outputPath).not.toBeNull();
  const output = decodeRgb16Tiff(await readFile(outputPath!));
  expect([output.width, output.height]).toEqual([64, 48]);
  expect(output.rgb).toHaveLength(64 * 48 * 3);
});
