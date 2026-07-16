import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Returns the lowercase SHA-256 digest used by the pinned asset manifests. */
export function sha256Hex(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToHex(sha256(new Uint8Array(bytes)));
}
