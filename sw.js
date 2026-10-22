// Familien-Planer Service Worker: App offline startbar machen
const C = 'fp-v4';
const CORE = ['./', './index.html', './config.js', './fb.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const own = u.origin === self.location.origin;
  const lib = u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/');
  const font = u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
  if (!own && !lib && !font) return;
  if (r.mode === 'navigate' || (own && /\/(index\.html)?$/.test(u.pathname))) {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); return res; }).catch(() => caches.match(r).then(m => m || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(r).then(m => { const net = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; }).catch(() => m); return m || net; }));
});

// Benachrichtigungen (kommen über Firebase Cloud Messaging, auch bei geschlossener App)
self.addEventListener('push', e => {
  let j = {}; try { j = e.data ? e.data.json() : {}; } catch (x) { j = { data: { body: e.data ? e.data.text() : '' } }; }
  const d = j.data || (j.notification) || j;
  const al = d.kind === 'alarm';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (d.kind === 'chat' && cs.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(d.title || 'Familien-Planer', {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png',
      requireInteraction: al, vibrate: al ? [600, 200, 600, 200, 600, 200, 600, 200, 600] : [200, 100, 200], data: { url: './', chat: (d.kind === 'chat' && /^chat_/.test(d.tag || '')) ? String(d.tag).slice(5) : '' }
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chat = (e.notification.data && e.notification.data.chat) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) { if (chat) c.postMessage({ openChat: chat }); return c.focus(); } }
    return self.clients.openWindow(chat ? './#chat=' + encodeURIComponent(chat) : './');
  }));
});
