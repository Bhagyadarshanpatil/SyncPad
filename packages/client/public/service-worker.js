self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'syncpad-ops') {
    event.waitUntil(syncOfflineOps());
  }
});

async function syncOfflineOps() {
  const clients = await self.clients.matchAll({ type: 'window' });
  
  if (clients.length > 0) {
    // If a tab is open, tell it to trigger a reconnect and sync.
    for (const client of clients) {
      client.postMessage({ type: 'trigger-sync' });
    }
  } else {
    // If the tab is closed, they remain safely in IndexedDB until the next time the app opens.
    console.log('[SW] No open clients to sync ops. Will sync on next app launch.');
  }
}
