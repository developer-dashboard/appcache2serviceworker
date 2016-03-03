importScripts('../build/legacy-appcache-behavior-import.js');

self.addEventListener('fetch', event => {
  event.respondWith(legacyAppCacheBehavior(event));
});
