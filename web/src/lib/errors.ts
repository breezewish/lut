const NIKON_HIGH_EFFICIENCY_RAW_ERROR =
  "LUTIFY_UNSUPPORTED_NIKON_HIGH_EFFICIENCY_RAW";

export function isNikonHighEfficiencyRawError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(NIKON_HIGH_EFFICIENCY_RAW_ERROR);
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
