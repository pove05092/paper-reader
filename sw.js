// sw.js : アプリの殻だけをキャッシュする Service Worker（仕様 §5）。
//  - 殻（HTML・CSS・JS・アイコン）はネットワーク優先、つながらなければキャッシュ → オフラインでも起動する。更新は次に開いた時に届く。
//  - 同梱の pdf.js（vendor/pdfjs/）は不変なのでキャッシュ優先。
//  - api.github.com など別のオリジンは一切触らない（キャッシュしない）。論文のデータは IndexedDB 側にある。
const VERSION = 'v1-2026-10-29';
const SHELL = `pr-shell-${VERSION}`;
const RUNTIME = `pr-runtime-${VERSION}`;
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/logic.js', 'js/geom.js', 'js/ui.js', 'js/store.js', 'js/github.js', 'js/sync.js', 'js/syncpill.js', 'js/pdf.js',
  'js/viewer.js', 'js/ink.js', 'js/toolbar.js', 'js/panel.js', 'js/library.js', 'js/upload.js', 'js/settings.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(CORE.map(async u => { try { await c.add(new Request(u, { cache: 'reload' })); } catch (err) { /* 1 つ欠けても残りで起動できるようにする */ } }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const immutable = url.pathname.includes('/vendor/pdfjs/');
    if (immutable) {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone()).catch(() => {});
      return res;
    }
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
