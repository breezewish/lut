import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Returns the lowercase SHA-256 digest used by the pinned asset manifests. */
export function sha256Hex(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToHex(sha256(new Uint8Array(bytes)));
}

/** Uses native asynchronous SHA-256 when available, with the portable
 * implementation preserving identical behavior on non-secure origins. */
export async function sha256HexAsync(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string> {
  const data = new Uint8Array(bytes);
  if (!globalThis.crypto?.subtle) return sha256Hex(data);
  return bytesToHex(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)),
  );
}
