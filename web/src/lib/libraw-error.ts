import { describeProcessingError } from "./errors";

interface EmscriptenExceptionModule {
  getExceptionMessage(error: unknown): [string, string];
  decrementExceptionRefcount(error: unknown): void;
}

/** Converts and releases an Emscripten C++ exception when one crosses into JS. */
export function describeLibRawError(
  error: unknown,
  module: EmscriptenExceptionModule,
): string {
  if (typeof error !== "object" || error === null || !("excPtr" in error)) {
    return describeProcessingError(error);
  }
  try {
    const [type, message] = module.getExceptionMessage(error);
    return describeProcessingError(new Error(`LibRaw ${type}: ${message}`));
  } catch {
    return describeProcessingError(error);
  } finally {
    module.decrementExceptionRefcount(error);
  }
}
