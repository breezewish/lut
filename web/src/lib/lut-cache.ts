import type { LutDefinition } from "../types";
import { sha256HexAsync } from "./hash";

/** Returns verified LUT bytes through the browser's content-addressed HTTP cache. */
export async function loadLutBytes(
  lut: LutDefinition,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(
    `${import.meta.env.BASE_URL}luts/${lut.file}`,
    globalThis.location.href,
  );
  // The hash changes the URL whenever the manifest points at new content.
  // A stable URL is therefore immutable and safe to reuse without revalidation.
  url.searchParams.set("sha256", lut.sha256);
  const response = await fetch(url, {
    cache: "force-cache",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Could not load LUT ${lut.name}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256HexAsync(bytes);
  if (actual !== lut.sha256) {
    throw new Error(`LUT integrity check failed for ${lut.name}.`);
  }
  return bytes;
}
