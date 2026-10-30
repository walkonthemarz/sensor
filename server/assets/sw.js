/* M701 dashboard service worker.
 *
 * Bump VERSION whenever index.html, script.js, chart.umd.min.js, the fonts, or
 * the icons change. The install step re-fetches the whole shell with the new
 * cache name, so a stale dashboard cannot survive a deploy.
 */
'use strict';

const VERSION = 'v1';
const SHELL_CACHE = 'm701-shell-' + VERSION;
const DATA_CACHE = 'm701-data-' + VERSION;

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/script.js?v=db29a479',
  '/chart.umd.min.js?v=1',
  '/fonts/gabarito-latin.woff2',
  '/fonts/gabarito-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);

    // Keep the newest readings around so the very first offline reload still
    // has a room to show. Never let a sleeping sensor block installation.
    const data = await caches.open(DATA_CACHE);
    try {
      const response = await fetch('/api/readings');
      if (response.ok) await data.put('/api/readings', response);
    } catch (_) { /* the sensor may be unreachable right now */ }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('m701-') && key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/readings') {
    event.respondWith(readingsResponse(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(pageResponse(request));
    return;
  }

  event.respondWith(assetResponse(request));
});

/* Readings go to the network first; the last successful payload is kept so a
 * reload without connectivity can still show the room instead of an empty
 * page. The marker header tells the dashboard the payload came from cache. */
async function readingsResponse(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (!cached) throw error;
    const headers = new Headers(cached.headers);
    headers.set('X-M701-Cache', 'hit');
    return new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }
}

/* Navigations prefer fresh HTML and update the offline shell as they go. */
async function pageResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/index.html', response.clone());
    return response;
  } catch (_) {
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
  }
}

/* Fonts, icons, scripts, and styles change rarely: serve the copy we have and
 * refresh it in the background. */
async function assetResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await update) || Response.error();
}
