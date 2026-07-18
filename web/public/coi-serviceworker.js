/* GitHub Pages cannot set the headers required by SharedArrayBuffer. This
 * service worker adds them to same-origin responses without caching content. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
    return;
  }
  if (new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request).then((response) => {
      if (response.type === "opaque") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
