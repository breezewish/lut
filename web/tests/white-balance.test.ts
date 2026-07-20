import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  whiteBalanceMatrix,
  writeWhiteBalanceUniform,
} from "../src/lib/white-balance";

interface Reference {
  studio_commit: string;
  cases: Array<{
    temperature: number;
    tint: number;
    matrix: number[][];
  }>;
}

const reference = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "tests/fixtures/studio-white-balance-reference.json",
    ),
    "utf8",
  ),
) as Reference;

describe("whiteBalanceMatrix", () => {
  test("matches the frozen Raw Alchemy Studio matrices", () => {
    expect(reference.studio_commit).toBe(
      "c9823146ba674be52d62f4c55b4c649f796bafd0",
    );
    for (const fixture of reference.cases) {
      const actual = whiteBalanceMatrix(fixture);
      const expected = fixture.matrix.flat();
      for (let index = 0; index < 9; index += 1) {
        expect(
          Math.abs(actual[index] - expected[index]),
          `${fixture.temperature}, ${fixture.tint}, matrix[${index}]`,
        ).toBeLessThan(1e-6);
      }
    }
  });

  test("keeps As Shot bit-exact and rejects values outside the UI contract", () => {
    expect([...whiteBalanceMatrix({ temperature: 0, tint: 0 })]).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    expect(() => whiteBalanceMatrix({ temperature: 101, tint: 0 })).toThrow(
      "within -100..=100",
    );
    expect(() => whiteBalanceMatrix({ temperature: 0, tint: NaN })).toThrow(
      "within -100..=100",
    );
  });

  test("writes three WGSL-aligned uniform rows", () => {
    const buffer = new ArrayBuffer(64);
    const view = new DataView(buffer);
    writeWhiteBalanceUniform(
      view,
      16,
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );

    expect([...new Float32Array(buffer)]).toEqual([
      0, 0, 0, 0, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ]);
  });
});
