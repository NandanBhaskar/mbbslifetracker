// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDFziS-dzhgDak5BmjU3ZLhXi9GlFM68rY",
  authDomain:        "mbbs-life-tracker-db577.firebaseapp.com",
  projectId:         "mbbs-life-tracker-db577",
  storageBucket:     "mbbs-life-tracker-db577.appspot.com",
  messagingSenderId: "420207686537",
  appId:             "1:420207686537:web:14d5a1dc3719e56925e758",
});

const messaging = firebase.messaging();

// Handle background messages (when app is not open)
messaging.onBackgroundMessage((payload) => {
  const { title, body, data } = payload.notification || payload.data || {};
  self.registration.showNotification(title || "MBBS Life Tracker", {
    body: body || "",
    icon: "/icon-192.png",
    badge: "/icon-96.png",
    data: data || {},
    actions: data?.action ? [{ action: data.action, title: "Open" }] : []
  });
});

// Deep link handling on notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
      return null;
    })
  );
});
