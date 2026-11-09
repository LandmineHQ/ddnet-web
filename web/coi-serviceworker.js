/* Cross-origin isolation shim for static hosts that cannot set COOP/COEP.
 * The first navigation registers this worker, then reloads once. Subsequent
 * navigation responses are rewritten with COOP/COEP so SharedArrayBuffer works.
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    const response = await fetch(event.request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(COI_HEADERS)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
