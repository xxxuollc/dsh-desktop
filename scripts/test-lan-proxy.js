// lan-proxy 独立测试（纯 Node，无 Electron）
'use strict';
const http = require('http');
const { createLanProxy, randomToken } = require('../lan-proxy.js');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
};

// ── 伪造上游：回显 Host/Origin，并提供一个流式端点 ──
const UPSTREAM = 3189;
const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ host: req.headers.host, origin: req.headers.origin, path: req.url });
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      res.write(`data: chunk-${i++}\n\n`);
      if (i >= 5) { clearInterval(timer); res.end(); }
    }, 50);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('upstream-ok');
});
upstream.listen(UPSTREAM, '127.0.0.1', async () => {
  const token = randomToken();
  const { server, port } = await createLanProxy({
    port: 3190, upstreamPort: UPSTREAM, token, onLog: (m) => console.log('  ', m),
  });
  const base = `http://127.0.0.1:${port}`;

  const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

  // 1. 无令牌 → 403
  let r = await get('/');
  check('无令牌 → 403', r.status === 403);

  // 2. 错误令牌 → 403
  r = await get('/?token=wrong');
  check('错误令牌 → 403', r.status === 403);

  // 3. 正确令牌 → 200 + Set-Cookie
  r = await get(`/?token=${token}`);
  const setCookie = r.headers.get('set-cookie') || '';
  check('正确令牌 → 200', r.status === 200);
  check('种下 HttpOnly cookie', /lan_token=.*HttpOnly/.test(setCookie));
  const body = await r.text();
  check('转发内容正确', body === 'upstream-ok');

  // 4. cookie 自动携带（不带 token 参数）
  r = await get('/api/x', { Cookie: setCookie.split(';')[0] });
  check('cookie 访问 → 200', r.status === 200);

  // 5. Host/Origin 重写（显式携带浏览器同源请求的 Origin 头）
  await get('/origin-check', {
    Cookie: setCookie.split(';')[0],
    Origin: `http://192.168.1.5:${port}`,
  });
  check('上游看到 Host=127.0.0.1:3189', seen.some((s) => s.host === `127.0.0.1:${UPSTREAM}`));
  check('Origin 被重写为 127.0.0.1:3189', seen.some((s) => s.origin === `http://127.0.0.1:${UPSTREAM}`));
  check('token 未泄漏给上游', seen.every((s) => !s.path.includes('token')));

  // 6. 流式转发（SSE）
  r = await get('/stream', { Cookie: setCookie.split(';')[0] });
  const streamBody = await r.text();
  check('SSE 流式转发完整', streamBody.includes('chunk-4') && streamBody.includes('chunk-0'));

  // 7. 上游挂了 → 502（带 cookie 才能过令牌关）
  upstream.closeAllConnections();
  await new Promise((res) => upstream.close(res));
  r = await get('/', { Cookie: setCookie.split(';')[0] });
  check('上游关闭 → 502', r.status === 502);

  server.close();
  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
});
