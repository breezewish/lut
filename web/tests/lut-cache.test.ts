import { afterEach, expect, test, vi } from "vitest";

import { sha256Hex } from "../src/lib/hash";
import { loadLutBytes } from "../src/lib/lut-cache";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("uses a hash-versioned URL with the browser HTTP cache", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = sha256Hex(bytes);
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(bytes),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    loadLutBytes({
      id: "look",
      group: "Test",
      name: "Look",
      file: "look.ralut",
      sha256,
    }),
  ).resolves.toEqual(bytes);

  expect(fetchMock).toHaveBeenCalledOnce();
  const [[url, options]] = fetchMock.mock.calls as unknown as Array<
    [RequestInfo | URL, RequestInit]
  >;
  expect(String(url)).toContain(`/luts/look.ralut?sha256=${sha256}`);
  expect(options).toEqual({
    cache: "force-cache",
    credentials: "same-origin",
  });
});

test("changes the cache URL when the manifest hash changes", async () => {
  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  const fetchMock = vi
    .fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response()),
    )
    .mockResolvedValueOnce(new Response(first))
    .mockResolvedValueOnce(new Response(second));
  vi.stubGlobal("fetch", fetchMock);

  await loadLutBytes({
    id: "look",
    group: "Test",
    name: "Look",
    file: "look.ralut",
    sha256: sha256Hex(first),
  });
  await loadLutBytes({
    id: "look",
    group: "Test",
    name: "Look",
    file: "look.ralut",
    sha256: sha256Hex(second),
  });

  expect(String(fetchMock.mock.calls[0][0])).not.toBe(
    String(fetchMock.mock.calls[1][0]),
  );
});
