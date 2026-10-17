// KasirKU service worker: lets the app open with no connection.
//
// It keeps the last good copy of the page and its scripts and stylesheet, and
// serves them only when the network fails. Online, everything comes fresh
// from the network (the platform's hosted bridge and UI kit included, so a
// platform fix still lands on the next load). It never answers /api/*:
// sales and every other read and write always go to the server, and the
// page keeps its own offline catalog and queue of unsent sales.
const CACHE = 'kasirku-shell-v1';
const PRECACHE = ['/app.js', '/tailwind.css'];
const ASSETS = /^\/(?:app\.js|tailwind\.css|usernode-bridge\/v1\/|usernode-native\/v1\/)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE))
    .catch(() => {})
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kasirku-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first; on success keep a copy (only of a good answer, so the
// "Open in Homeroom" sign-in page is never cached), on failure use the copy.
function networkFirst(request, key) {
  return fetch(request).then((res) => {
    const type = res.headers.get('content-type') || '';
    const keep = res.ok && (request.mode !== 'navigate' || type.includes('text/html'));
    if (keep) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(key).then((hit) => hit || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // The page is one document whatever its query (the token rides on it), so
  // it is kept under "/" with the query dropped.
  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, '/')); return; }
  if (ASSETS.test(url.pathname)) event.respondWith(networkFirst(req, url.pathname));
});
