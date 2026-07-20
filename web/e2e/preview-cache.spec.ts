import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const fixture = resolve("tests/fixtures/linear.dng");

test("keeps per-photo edits and previews warm while switching photos", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const bytes = await readFile(fixture);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "second.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
  ]);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".look:not(.is-loading)")).toHaveCount(27, {
    timeout: 20_000,
  });

  await page.getByRole("slider", { name: "Exposure" }).fill("1");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            performance
              .getEntriesByName("lutify:look-preview-batch")
              .filter(
                (entry) =>
                  (entry as PerformanceMark).detail.ev === 1 &&
                  (entry as PerformanceMark).detail.completed === 27,
              ).length,
        ),
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.locator(".look").nth(1).click();
  await expect(page.locator(".look").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: /^second\.dng/ }).click();
  await expect(
    page.getByRole("button", { name: /second\.dng — Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await page.getByRole("slider", { name: "Exposure" }).fill("-1");
  await expect(page.getByLabel("Preview processing")).toHaveCount(0, {
    timeout: 20_000,
  });

  await page.getByRole("button", { name: /^first\.dng/ }).click();
  await expect(
    page.getByRole("button", { name: /first\.dng — Ready/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel("Base preview")).toBeVisible();
  await expect(page.getByText("Decoding preview…")).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "Exposure value" }),
  ).toHaveValue("1");
  await expect(page.locator(".look").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  expect(
    await page.evaluate(
      () => performance.getEntriesByName("lutify:preview-worker").length,
    ),
  ).toBe(2);
});

test("retains six decoded GPU sources independently from the three-frame UI cache", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const bytes = await readFile(fixture);
  const files = Array.from({ length: 7 }, (_, index) => ({
    name: `photo-${index + 1}.dng`,
    mimeType: "image/x-adobe-dng",
    buffer: bytes,
  }));

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(files);
  for (let index = 0; index < files.length; index += 1) {
    if (index > 0) {
      await page
        .getByRole("button", { name: new RegExp(`^photo-${index + 1}\\.dng`) })
        .click();
    }
    await expect(
      page.getByRole("button", {
        name: new RegExp(`photo-${index + 1}\\.dng — Ready`),
      }),
    ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  }

  await page.getByRole("button", { name: /^photo-2\.dng/ }).click();
  await expect(
    page.getByRole("button", { name: /photo-2\.dng — Ready/ }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("lutify:preview-worker").length,
    ),
  ).toBe(7);

  await page.getByRole("button", { name: /^photo-1\.dng/ }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => performance.getEntriesByName("lutify:preview-worker").length,
        ),
      { timeout: 20_000 },
    )
    .toBe(8);
});
