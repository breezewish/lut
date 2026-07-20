import reference from "../../tests/fixtures/corrected-v2-reference.json";

import type { GpuLut } from "./lib/webgpu-color";
import {
  WebGpuPreviewRenderer,
  WebGpuPreviewSource,
} from "./lib/webgpu-preview";

export function mountPreviewCorrectness(): void {
  document.body.dataset.benchmarkStatus = "running";
  void run().then(
    (results) => {
      performance.mark("lutify:preview-correctness", {
        detail: { results },
      });
      document.body.dataset.benchmarkStatus = "complete";
    },
    (error: unknown) => {
      document.body.dataset.benchmarkError =
        error instanceof Error ? error.message : String(error);
      document.body.dataset.benchmarkStatus = "failed";
    },
  );
}

async function run() {
  const samples = reference.cube
    .split("\n")
    .filter((line) => /^[-+\d.]/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  const lut: GpuLut = {
    size: () => 2,
    domain_min: () => new Float32Array([0, 0, 0]),
    domain_max: () => new Float32Array([1, 1, 1]),
    samples: () => new Float32Array(samples),
  };
  const results = [];
  for (const testCase of reference.cases) {
    const source = await WebGpuPreviewSource.create(
      new Uint16Array(testCase.pixels),
      testCase.width,
      testCase.height,
    );
    const renderer = await WebGpuPreviewRenderer.create(source, lut);
    try {
      const preview = await renderer.render(
        testCase.ev,
        Math.max(testCase.width, testCase.height),
        true,
      );
      results.push({
        name: testCase.name,
        baseMaximumDifference: maximumDifference(
          preview.base!,
          testCase.base_rgba,
        ),
        lutMaximumDifference: maximumDifference(preview.lut, testCase.lut_rgba),
      });
    } finally {
      renderer.free();
      source.free();
    }
  }
  return results;
}

function maximumDifference(actual: Uint8Array, expected: number[]): number {
  if (actual.length !== expected.length) {
    throw new Error(
      `Preview produced ${actual.length} bytes; expected ${expected.length}.`,
    );
  }
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]));
  }
  return maximum;
}
