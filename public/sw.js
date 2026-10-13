// Service worker: lets the page raise actionable notifications and bring the app forward when one is tapped.
// It does not cache API data (everything is live) and never holds credentials.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const target = event.notification.data && event.notification.data.url ? event.notification.data.url : '/#/approvals';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); c.postMessage({ type: 'navigate', url: target }); return; } }
    await self.clients.openWindow(target);
  })());
});
