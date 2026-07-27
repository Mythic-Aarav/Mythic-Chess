// client/sw.js
// Minimal service worker — required by most browsers before they'll offer
// an "install app" prompt. It doesn't need to cache anything for that.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Pass-through: let the network handle every request as normal.
});
