const SHELL = [
  '/ui',
  '/ui/',
  '/ui/index.html',
  '/ui/app.js',
  '/ui/styles.css',
  '/ui/state.js',
  '/ui/render.js',
  '/ui/manifest.webmanifest',
  '/ui/icon.svg',
];

const NETWORK_ONLY = ['/rpc', '/ws', '/sessions', '/health'];

function pathOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

function isNetworkOnly(pathname) {
  return NETWORK_ONLY.some(function (prefix) {
    return pathname === prefix || pathname.indexOf(prefix + '/') === 0;
  });
}

function isShell(pathname) {
  return SHELL.indexOf(pathname) !== -1;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open('babel-remote-shell-v1').then(function (cache) {
      return cache.addAll(SHELL);
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  const pathname = pathOf(event.request);
  if (event.request.method !== 'GET' || isNetworkOnly(pathname) || event.request.headers.get('authorization')) {
    return;
  }
  if (!isShell(pathname)) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(event.request);
    }),
  );
});
