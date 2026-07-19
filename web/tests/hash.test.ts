import { expect, test } from "vitest";

import { sha256Hex, sha256HexAsync } from "../src/lib/hash";

test("hashes assets without requiring Web Crypto", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hashes assets through the asynchronous runtime path", async () => {
  await expect(sha256HexAsync(new TextEncoder().encode("abc"))).resolves.toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
