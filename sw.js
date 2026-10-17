const CACHE = 'student-rocket-sim-v6';
const FILES = ['./', 'index.html', 'style.css', 'geo.js','terrain.js','physics.js','analysis.js','analysis-worker.js','verify.js','design.js', 'specsheet.js', 'dispersion.js', 'app.js', 'view3d.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// ネットワーク優先・オフライン時はキャッシュ（地図タイルはキャッシュしない）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.hostname === 'tile.openstreetmap.org' || u.hostname === 'cyberjapandata.gsi.go.jp') return; // 地図・標高タイルはキャッシュしない
  // 同じオリジンのファイルは HTTP キャッシュを再検証する（更新後に古い app.js と新しい index.html が混ざらないように）
  const req = u.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(req).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
