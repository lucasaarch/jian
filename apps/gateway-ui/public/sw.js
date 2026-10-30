self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Remove the offline cache from earlier installations; no private or static data is cached.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('jian-offline-')).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// What the gateway pushes when the agent answers or asks in a chat: shown always, one per chat
// (a newer one takes the older's place). A push left unshown costs the permission on iOS.
self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = { body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(notice.title || 'Jian', {
      body: notice.body || '',
      tag: notice.tag,
      renotify: Boolean(notice.tag),
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-192.png',
      data: { url: notice.url || '/' },
    }),
  );
});

// Opens the chat it is about: in a window of the panel already open, or a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        const moved = await open.navigate(url).catch(() => null);
        if (moved) return;
      }
      await self.clients.openWindow(url);
    }),
  );
});
