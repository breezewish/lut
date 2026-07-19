import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const linearFixture = resolve("tests/fixtures/linear.dng");

test("rebuilding assets keeps a live development server usable", async ({
  page,
}) => {
  const origin = "http://127.0.0.1:42733";
  const server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "42733",
      "--strictPort",
    ],
    { stdio: "ignore" },
  );

  try {
    await expect
      .poll(async () => {
        try {
          const response = await fetch(`${origin}/luts/manifest.json`);
          return response.headers.get("content-type");
        } catch {
          return undefined;
        }
      })
      .toContain("application/json");

    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Start with a camera RAW" }),
    ).toBeVisible();

    await execFileAsync(process.execPath, [
      resolve("scripts/prepare-assets.mjs"),
    ]);

    const manifestResponse = await fetch(`${origin}/luts/manifest.json`);
    expect(manifestResponse.headers.get("content-type")).toContain(
      "application/json",
    );
    const manifest = (await manifestResponse.json()) as {
      luts: Array<{ file: string }>;
    };
    expect(manifest.luts).toHaveLength(27);
    const lutResponses = await Promise.all(
      manifest.luts.map((lut) =>
        fetch(`${origin}/luts/${lut.file}`, { method: "HEAD" }),
      ),
    );
    expect(lutResponses.every((response) => response.ok)).toBe(true);
    expect(
      lutResponses.every(
        (response) =>
          !response.headers.get("content-type")?.includes("text/html"),
      ),
    ).toBe(true);

    await page.reload();
    await page.locator('input[type="file"]').setInputFiles(linearFixture);
    await expect(
      page.getByRole("button", { name: "Classic Negative", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Base preview")).toBeVisible({
      timeout: 20_000,
    });
    const pixelRange = await page
      .getByLabel("Base preview")
      .evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let minimum = 255;
        let maximum = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          minimum = Math.min(
            minimum,
            pixels[index],
            pixels[index + 1],
            pixels[index + 2],
          );
          maximum = Math.max(
            maximum,
            pixels[index],
            pixels[index + 1],
            pixels[index + 2],
          );
        }
        return maximum - minimum;
      });
    expect(pixelRange).toBeGreaterThan(32);
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  }
});
