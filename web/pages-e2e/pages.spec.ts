import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const linearFixture = resolve("tests/fixtures/linear.dng");

test("the repository subpath loads every runtime asset and previews a RAW", async ({
  page,
}) => {
  const responses: Array<{ status: number; url: string }> = [];
  page.on("response", (response) => {
    responses.push({ status: response.status(), url: response.url() });
  });

  await page.goto("./");
  await page.locator('input[type="file"]').setInputFiles(linearFixture);
  await expect(page.getByLabel("Base preview")).toBeVisible({
    timeout: 20_000,
  });

  const sameOriginResponses = responses.filter(
    ({ url }) => new URL(url).origin === "http://127.0.0.1:42733",
  );
  const paths = sameOriginResponses.map(({ url }) => new URL(url).pathname);
  expect(sameOriginResponses.length).toBeGreaterThan(0);
  expect(paths.every((path) => path.startsWith("/lut/"))).toBe(true);
  expect(paths.some((path) => path.endsWith("/luts/manifest.json"))).toBe(true);
  expect(
    paths.some(
      (path) => path.includes("/luts/") && !path.endsWith("/manifest.json"),
    ),
  ).toBe(true);
  expect(paths.some((path) => path.includes("/processing.worker-"))).toBe(true);
  expect(paths.filter((path) => path.endsWith(".wasm"))).toHaveLength(2);
  expect(sameOriginResponses.every(({ status }) => status < 400)).toBe(true);
});
