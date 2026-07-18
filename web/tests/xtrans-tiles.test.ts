import { describe, expect, it } from "vitest";
import {
  createXtransPattern,
  createXtransTiles,
} from "../src/lib/xtrans-tiles";

const X_T1_CFA = [
  0, 2, 1, 2, 0, 1, 1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1,
  2, 1, 1, 0, 1, 1, 0, 1, 1, 2,
];

describe("X-Trans geometry", () => {
  it("builds LibRaw's complete phase-dependent neighbor map", () => {
    const pattern = createXtransPattern(X_T1_CFA);

    expect(pattern.solitaryGreenRow).toBe(0);
    expect(pattern.solitaryGreenColumn).toBe(2);
    expect(pattern.hexDeltas).toHaveLength(144);
    expect(Array.from(pattern.hexDeltas)).not.toContain(32700);
  });

  it("covers rectangular edge tiles exactly once", () => {
    expect(createXtransTiles(1024, 768)).toEqual([
      {
        inputX: 3,
        inputY: 3,
        inputWidth: 512,
        inputHeight: 512,
        outputX: 0,
        outputY: 0,
        outputWidth: 507,
        outputHeight: 507,
      },
      {
        inputX: 499,
        inputY: 3,
        inputWidth: 512,
        inputHeight: 512,
        outputX: 507,
        outputY: 0,
        outputWidth: 496,
        outputHeight: 507,
      },
      {
        inputX: 995,
        inputY: 3,
        inputWidth: 26,
        inputHeight: 512,
        outputX: 1003,
        outputY: 0,
        outputWidth: 21,
        outputHeight: 507,
      },
      {
        inputX: 3,
        inputY: 499,
        inputWidth: 512,
        inputHeight: 266,
        outputX: 0,
        outputY: 507,
        outputWidth: 507,
        outputHeight: 261,
      },
      {
        inputX: 499,
        inputY: 499,
        inputWidth: 512,
        inputHeight: 266,
        outputX: 507,
        outputY: 507,
        outputWidth: 496,
        outputHeight: 261,
      },
      {
        inputX: 995,
        inputY: 499,
        inputWidth: 26,
        inputHeight: 266,
        outputX: 1003,
        outputY: 507,
        outputWidth: 21,
        outputHeight: 261,
      },
    ]);
  });
});
