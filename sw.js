// Mode hors ligne et notifications de l'application web (tablette et téléphone).
// Réseau d'abord : une nouvelle version publiée est prise tout de suite ; la copie sert si la connexion tombe.
const CACHE = 'dayan3d-planning-v2.9.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'boot.js',
  'app.js',
  'config.js',
  'pwa.js',
  'manifest.webmanifest',
  'vendor/supabase.js',
  'vendor/qrcode.js',
  'img/logo.png',
  'img/icon-192.png',
  'img/icon-512.png',
  'img/apple-touch-icon.png',
  'fonts/cinzel-latin-600-normal.woff2',
  'fonts/cinzel-latin-700-normal.woff2',
  'fonts/jost-latin-400-normal.woff2',
  'fonts/jost-latin-500-normal.woff2',
  'fonts/jost-latin-600-normal.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // les données (Supabase) ne passent jamais par le cache
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list.length ? list[0].focus() : self.clients.openWindow('./'))));
});
