import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const linearFixture = resolve("tests/fixtures/linear.dng");
const lossyFixture = resolve("vendor/LibRaw-Wasm/test/integration/lossy.dng");

test("rapid selection keeps the preview and metadata on the latest RAW", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles([linearFixture, lossyFixture]);
  await page.getByRole("button", { name: /^lossy\.dng/ }).click();

  await expect(
    page.getByRole("button", { name: /lossy\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 30_000 });
  await expect(
    page.getByLabel("Current document").getByText("256 × 168"),
  ).toBeVisible();
  await expect(page.getByLabel("Base preview")).toBeVisible();
});

test("batch export continues after an export-time RAW failure", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    const readCounts = new WeakMap<File, number>();
    File.prototype.arrayBuffer = function () {
      const count = (readCounts.get(this) ?? 0) + 1;
      readCounts.set(this, count);
      if (this.name === "middle.dng" && count > 1) {
        return Promise.resolve(
          new TextEncoder().encode("corrupt at export").buffer,
        );
      }
      return original.call(this);
    };
  });
  const bytes = await readFile(lossyFixture);
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "middle.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
    { name: "third.dng", mimeType: "image/x-adobe-dng", buffer: bytes },
  ]);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /^middle\.dng/ }).click();
  await expect(
    page.getByRole("button", { name: /middle\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await page
    .getByRole("button", { name: /^first\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /first\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await page
    .getByRole("button", { name: /^third\.dng/ })
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("button", { name: /third\.dng.*Ready/ }),
  ).toHaveAttribute("aria-current", "true", { timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export 3 photos" }).click();
  const download = await downloadPromise;
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  expect(Object.keys(archive).sort()).toEqual([
    "first-fuji-classic-negative.tif",
    "third-fuji-classic-negative.tif",
  ]);
  await expect(
    page.getByText("Exported 2 of 3. Failed: middle.dng."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /middle\.dng.*Failed/ }),
  ).toBeVisible();
});

test("duplicate files in one chooser selection are ignored", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles([linearFixture, linearFixture]);

  await expect(page.getByRole("button", { name: /^linear\.dng/ })).toHaveCount(
    1,
  );
});

test("a dropped RAW is decoded and a removed selection can be restored", async ({
  page,
}) => {
  const [bytes, metadata] = await Promise.all([
    readFile(linearFixture),
    stat(linearFixture),
  ]);
  await page.goto("/");
  await page.getByLabel("Photo filmstrip").evaluate(
    (queue, { contents, lastModified }) => {
      const file = new File([new Uint8Array(contents)], "dropped.dng", {
        type: "image/x-adobe-dng",
        lastModified,
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      queue.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          dataTransfer: transfer,
        }),
      );
    },
    { contents: Array.from(bytes), lastModified: metadata.mtimeMs },
  );
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Remove dropped.dng" }).click();
  await expect(
    page.getByRole("button", { name: /Drop RAW files here/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^dropped\.dng/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
});

test("the Look catalog groups camera families and keeps selection stable", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });
  const catalog = page.getByRole("group", { name: "Built-in looks" });
  await expect(catalog.getByRole("group", { name: "Fujifilm" })).toContainText(
    "Classic Negative",
  );
  await expect(catalog.getByRole("group", { name: "Nikon" })).toContainText(
    "RED Film Bias",
  );
  await expect(catalog.getByRole("group", { name: "RED" })).toContainText(
    "Medium Contrast Soft",
  );
  const firstLook = await catalog
    .getByRole("button")
    .first()
    .getAttribute("aria-label");
  await catalog.getByRole("button", { name: "PROVIA", exact: true }).click();
  await expect(page.getByLabel("PROVIA preview")).toBeVisible();
  await expect(
    catalog.getByRole("button", { name: "PROVIA", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(catalog.getByRole("button").first()).toHaveAccessibleName(
    firstLook!,
  );
});
