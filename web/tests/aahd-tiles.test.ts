import { describe, expect, it } from "vitest";
import { createAahdTiles } from "../src/lib/aahd-tiles";

describe("createAahdTiles", () => {
  it("covers rectangular edges once and clips only the global border halo", () => {
    expect(createAahdTiles(18, 14, 8, 4)).toEqual([
      {
        coreX: 0,
        coreY: 0,
        coreWidth: 8,
        coreHeight: 8,
        inputX: 0,
        inputY: 0,
        inputWidth: 12,
        inputHeight: 12,
        localCoreX: 0,
        localCoreY: 0,
      },
      {
        coreX: 8,
        coreY: 0,
        coreWidth: 8,
        coreHeight: 8,
        inputX: 4,
        inputY: 0,
        inputWidth: 14,
        inputHeight: 12,
        localCoreX: 4,
        localCoreY: 0,
      },
      {
        coreX: 16,
        coreY: 0,
        coreWidth: 2,
        coreHeight: 8,
        inputX: 12,
        inputY: 0,
        inputWidth: 6,
        inputHeight: 12,
        localCoreX: 4,
        localCoreY: 0,
      },
      {
        coreX: 0,
        coreY: 8,
        coreWidth: 8,
        coreHeight: 6,
        inputX: 0,
        inputY: 4,
        inputWidth: 12,
        inputHeight: 10,
        localCoreX: 0,
        localCoreY: 4,
      },
      {
        coreX: 8,
        coreY: 8,
        coreWidth: 8,
        coreHeight: 6,
        inputX: 4,
        inputY: 4,
        inputWidth: 14,
        inputHeight: 10,
        localCoreX: 4,
        localCoreY: 4,
      },
      {
        coreX: 16,
        coreY: 8,
        coreWidth: 2,
        coreHeight: 6,
        inputX: 12,
        inputY: 4,
        inputWidth: 6,
        inputHeight: 10,
        localCoreX: 4,
        localCoreY: 4,
      },
    ]);
  });

  it("uses one clipped tile for an image smaller than the core", () => {
    expect(createAahdTiles(6, 4, 8, 4)).toEqual([
      {
        coreX: 0,
        coreY: 0,
        coreWidth: 6,
        coreHeight: 4,
        inputX: 0,
        inputY: 0,
        inputWidth: 6,
        inputHeight: 4,
        localCoreX: 0,
        localCoreY: 0,
      },
    ]);
  });

  it("rejects geometry that would split packed Bayer pairs", () => {
    expect(() => createAahdTiles(7, 4)).toThrow(/positive even/);
    expect(() => createAahdTiles(8, 4, 7, 4)).toThrow(/positive even/);
    expect(() => createAahdTiles(8, 4, 8, 3)).toThrow(/positive even/);
  });
});
