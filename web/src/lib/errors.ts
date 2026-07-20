export type UnsupportedRawFormat =
  | "nikon-high-efficiency"
  | "gopro-gpr"
  | "jpeg-xl-dng";

const UNSUPPORTED_RAW_ERRORS: ReadonlyArray<
  readonly [string, UnsupportedRawFormat]
> = [
  ["LUTIFY_UNSUPPORTED_NIKON_HIGH_EFFICIENCY_RAW", "nikon-high-efficiency"],
  ["LUTIFY_UNSUPPORTED_GOPRO_GPR", "gopro-gpr"],
  ["LUTIFY_UNSUPPORTED_JPEG_XL_DNG", "jpeg-xl-dng"],
];

export function getUnsupportedRawFormat(
  error: unknown,
): UnsupportedRawFormat | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return UNSUPPORTED_RAW_ERRORS.find(([marker]) =>
    message.includes(marker),
  )?.[1];
}

export function describeProcessingError(error: unknown): string {
  if (error instanceof Error && error.message)
    return describeMessage(error.message);
  if (typeof error === "object" && error !== null) {
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message
    ) {
      return describeMessage(error.message);
    }
    if ("excPtr" in error) {
      return "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet.";
    }
  }
  const message = String(error);
  return message === "[object Object]"
    ? "RAW processing failed with an unknown error."
    : describeMessage(message);
}

function describeMessage(message: string): string {
  return /open_buffer|unsupported file format|decode this RAW|LibRaw could not (?:open|unpack|decode)/i.test(
    message,
  )
    ? "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet."
    : message;
}
