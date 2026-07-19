import { expect, test } from "@playwright/test";

test("starts every hash-versioned LUT request concurrently on app open", async ({
  page,
}) => {
  const requests = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/luts/*.ralut?sha256=*", async (route) => {
    requests.add(route.request().url());
    await gate;
    await route.continue();
  });

  await page.goto("/");
  await expect.poll(() => requests.size).toBe(27);
  for (const url of requests) {
    expect(new URL(url).searchParams.get("sha256")).toMatch(/^[a-f\d]{64}$/);
  }

  release();
});
