import { expect, test } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const enabled = process.env.DEMOSAIC_PERF === "1";
const fixture = resolve(
  process.env.DEMOSAIC_PERF_FIXTURE ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const samples = Number(process.env.DEMOSAIC_PERF_SAMPLES ?? "5");
const backend = process.env.DEMOSAIC_PERF_BACKEND ?? "onnx";
const contract =
  process.env.DEMOSAIC_PERF_CONTRACT ?? "deterministic-parallel-candidate";
const outputStage =
  process.env.DEMOSAIC_PERF_OUTPUT_STAGE ??
  (backend === "native-wgsl"
    ? "identity-lut"
    : backend === "libraw-aahd-wgsl"
      ? "final"
      : "demosaic");
const completeExport = process.env.DEMOSAIC_PERF_COMPLETE_EXPORT === "1";
const librawReference = process.env.DEMOSAIC_PERF_LIBRAW_REFERENCE === "1";
const candidateReference =
  process.env.DEMOSAIC_PERF_CANDIDATE_REFERENCE === "1";
const reference = process.env.DEMOSAIC_PERF_REFERENCE
  ? resolve(process.env.DEMOSAIC_PERF_REFERENCE)
  : undefined;

test("records LibRaw-unpack plus GPU demosaic performance", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "Set DEMOSAIC_PERF=1 to run the GPU demosaic benchmark.");
  test.setTimeout(15 * 60_000);
  const fixtureStat = await stat(fixture);
  const runs = [];
  page.on("console", (message) =>
    console.log(`[browser:${message.type()}] ${message.text()}`),
  );
  page.on("pageerror", (error) => console.log(`[browser:error] ${error}`));
  await page.goto(
    `/?demosaicBenchmark=1&demosaicBackend=${encodeURIComponent(backend)}&demosaicContract=${encodeURIComponent(contract)}&demosaicOutputStage=${encodeURIComponent(outputStage)}&completeExport=${completeExport ? "1" : "0"}&librawReference=${librawReference ? "1" : "0"}&candidateReference=${candidateReference ? "1" : "0"}`,
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-benchmark-status",
    "ready",
  );

  for (let index = 0; index < samples; index += 1) {
    await page.evaluate(() => {
      performance.clearMarks();
      document.body.dataset.benchmarkStatus = "running";
      delete document.body.dataset.benchmarkError;
    });
    const wallStartedAt = performance.now();
    if (reference) {
      await page
        .getByLabel("Demosaic RGB16 reference")
        .setInputFiles(reference);
      await expect
        .poll(() =>
          page.locator("body").getAttribute("data-benchmark-reference"),
        )
        .toBe("ready");
    }
    await page.getByLabel("Demosaic benchmark RAW").setInputFiles(fixture);
    await expect
      .poll(
        async () => page.locator("body").getAttribute("data-benchmark-status"),
        {
          timeout: 15 * 60_000,
        },
      )
      .not.toBe("running");
    const status = await page
      .locator("body")
      .getAttribute("data-benchmark-status");
    if (status === "error") {
      throw new Error(
        `Browser demosaic failed: ${await page.locator("body").getAttribute("data-benchmark-error")}`,
      );
    }
    const report = await page.evaluate(
      () =>
        (
          performance
            .getEntriesByName("raw-alchemy:demosaic-benchmark")
            .at(-1) as PerformanceMark
        ).detail,
    );
    runs.push({ wallMs: performance.now() - wallStartedAt, report });
  }

  const reportPath = testInfo.outputPath("demosaic-performance.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture,
        fixtureBytes: fixtureStat.size,
        samples,
        backend,
        contract,
        outputStage,
        completeExport,
        librawReference,
        candidateReference,
        coldRun: runs[0],
        warmRuns: runs.slice(1),
      },
      null,
      2,
    ),
  );
  await testInfo.attach("demosaic-performance.json", {
    path: reportPath,
    contentType: "application/json",
  });
});
