import { expect, test } from "vitest";

import { describeProcessingError } from "../src/lib/errors";

test("turns opaque Embind exceptions into an actionable RAW error", () => {
  expect(describeProcessingError({ excPtr: 1_536_184 })).toBe(
    "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet.",
  );
  expect(
    describeProcessingError(
      new Error(
        "LibRaw std::runtime_error: LibRaw: open_buffer() failed with code -100009",
      ),
    ),
  ).toBe(
    "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet.",
  );
  expect(describeProcessingError(new Error("LUT integrity check failed"))).toBe(
    "LUT integrity check failed",
  );
});
