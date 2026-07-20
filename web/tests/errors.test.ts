import { expect, test } from "vitest";

import {
  describeProcessingError,
  getUnsupportedRawFormat,
} from "../src/lib/errors";

test("classifies known unsupported RAW decoders without guessing from generic errors", () => {
  expect(
    getUnsupportedRawFormat(
      new Error("LUTIFY_UNSUPPORTED_NIKON_HIGH_EFFICIENCY_RAW"),
    ),
  ).toBe("nikon-high-efficiency");
  expect(
    getUnsupportedRawFormat(new Error("LUTIFY_UNSUPPORTED_GOPRO_GPR")),
  ).toBe("gopro-gpr");
  expect(
    getUnsupportedRawFormat(new Error("LUTIFY_UNSUPPORTED_JPEG_XL_DNG")),
  ).toBe("jpeg-xl-dng");
  expect(
    getUnsupportedRawFormat(
      new Error("LibRaw could not decode: Unsupported file format"),
    ),
  ).toBeUndefined();
});

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
  expect(
    describeProcessingError(
      new Error("LibRaw std::runtime_error: LibRaw could not open: I/O error"),
    ),
  ).toBe(
    "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet.",
  );
  expect(describeProcessingError(new Error("LUT integrity check failed"))).toBe(
    "LUT integrity check failed",
  );
  expect(
    describeProcessingError(new Error("LibRaw AAHD shader failed at line 42")),
  ).toBe("LibRaw AAHD shader failed at line 42");
});
