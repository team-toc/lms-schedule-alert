const FALLBACK = {
  title: 'TOC 일정 알림',
  body: '새로운 알림을 확인해 주세요.',
  url: '/?view=notifications'
};

self.addEventListener('push', (event) => {
  let payload;

  try {
    payload = event.data?.json();
  } catch {
    payload = null;
  }

  const valid = payload?.v === 1 && typeof payload.title === 'string';
  const data = valid ? payload : FALLBACK;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: valid
        ? (data.notificationId != null ? `n${data.notificationId}` : data.kind || 'toc')
        : 'toc-fallback',
      renotify: true,
      data: {
        url: valid && typeof data.url === 'string' ? data.url : FALLBACK.url
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const origin = self.location.origin;
    let target = new URL('/', origin);

    try {
      const requested = new URL(event.notification.data?.url || '/', origin);
      if (requested.origin === origin) target = requested;
    } catch {
      // 잘못된 URL이면 홈으로 이동
    }

    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    const existing = windows.find(
      (client) => new URL(client.url).origin === origin
    );

    if (existing) {
      await existing.focus();
      await existing.navigate(target.href);
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})