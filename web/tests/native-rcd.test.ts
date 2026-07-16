import { describe, expect, it } from "vitest";

import { createIdentityLut } from "../src/lib/native-rcd";

describe("native RCD support", () => {
  it("lays out the identity LUT with red as the fastest axis", () => {
    const lut = createIdentityLut(2);

    expect(Array.from(lut)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
    ]);
  });
});
