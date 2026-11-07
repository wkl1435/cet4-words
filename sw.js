/* 四级词汇 · 49 天 — Service Worker
 * 策略：
 *   - 页面导航：网络优先，断网回落到缓存的 index.html（保证总能拿到新版）
 *   - 图标 / manifest：缓存优先 + 后台更新
 *   - audio/ 下的 mp3：按需缓存（播放过才存），最多 300 条，避免占满空间
 *   - 第三方请求（有道发音）：完全交给网络，不缓存
 */
const CORE = 'cet4-core-v1';
const AUDIO = 'cet4-audio-v1';
const AUDIO_LIMIT = 300;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const scope = self.registration.scope;
    const files = [scope, scope + 'index.html', scope + 'manifest.json',
      scope + 'icon-192.png', scope + 'icon-512.png'];
    const c = await caches.open(CORE);
    /* 逐个 add，单个失败不影响整体安装 */
    await Promise.all(files.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== CORE && k !== AUDIO)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return; /* 有道发音等第三方直连 */

  /* 音频：缓存优先 */
  if (url.pathname.indexOf('/audio/') !== -1) {
    e.respondWith((async () => {
      const c = await caches.open(AUDIO);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          await trimAudio(c);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* 页面导航：网络优先 */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CORE);
      try {
        const res = await fetch(req);
        if (res && res.ok) c.put(self.registration.scope + 'index.html', res.clone());
        return res;
      } catch (err) {
        const cached = (await c.match(self.registration.scope + 'index.html'))
          || (await c.match(self.registration.scope))
          || (await c.match(req));
        return cached || new Response('当前离线，请联网后打开一次。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  /* 其它同源静态资源：缓存优先 + 后台更新 */
  e.respondWith((async () => {
    const c = await caches.open(CORE);
    const hit = await c.match(req);
    const net = fetch(req).then(res => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response('', { status: 504 });
  })());
});

async function trimAudio(cache) {
  const keys = await cache.keys();
  if (keys.length <= AUDIO_LIMIT) return;
  const drop = keys.slice(0, keys.length - AUDIO_LIMIT);
  await Promise.all(drop.map(k => cache.delete(k)));
}
