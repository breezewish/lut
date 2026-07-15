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
  return /LibRaw|open_buffer|unsupported file format|decode this RAW/i.test(
    message,
  )
    ? "Unable to read this RAW. The file may be damaged, or its camera format may not be supported yet."
    : message;
}
