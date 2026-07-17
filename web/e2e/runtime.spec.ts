import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const linearFixture = resolve("tests/fixtures/linear.dng");
const httpPort = process.env.PLAYWRIGHT_HTTP_PORT ?? "42731";

test("rejects RAW processing on an origin where WebGPU is unavailable", async ({
  page,
}) => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find(
      (candidate) =>
        candidate?.family === "IPv4" && candidate.internal === false,
    )?.address;
  expect(address, "a non-loopback IPv4 address is required").toBeDefined();

  await page.goto(`http://${address}:${httpPort}/`);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.locator('input[type="file"]').setInputFiles(linearFixture);

  await expect(page.getByRole("alert")).toContainText(
    "WebGPU is required to process RAW files",
  );
  await expect(page.getByLabel("Base preview")).toHaveCount(0);
});
