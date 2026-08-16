// lan-proxy.js — 局域网安全代理（独立模块，无 Electron 依赖，可单独测试）
// 作用：壳进程监听 0.0.0.0:<port>，校验令牌后把请求转发到本机 127.0.0.1:<upstreamPort>。
// 安全模型：
//   - 不触碰 dsh 的 0.0.0.0 禁令（服务端仍只绑 127.0.0.1，防 RCE 暴露）
//   - 代理侧令牌门禁：无令牌一律 403；首次带 ?token= 访问会种下 HttpOnly cookie
//   - Host/Origin 头重写为上游地址，通过 dsh 的浏览器信任围栏（防 DNS rebinding 的 Host 校验）
'use strict';

const http = require('http');
const crypto = require('crypto');
const { buildInjection } = require('./lan-inject.js');

const FORBIDDEN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>拒绝访问</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;background:#0b0d14;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}.code{font-size:64px;color:#f87171;font-weight:700}.msg{color:#94a3b8;margin-top:12px}</style></head>
<body><div><div class="code">403</div><div class="msg">缺少或无效的访问令牌。<br>请用 DSH Desktop 的「局域网访问」二维码打开。</div></div></body></html>`;

/**
 * 创建局域网代理
 * @param {object} opts
 * @param {number} opts.port         代理监听端口
 * @param {number} opts.upstreamPort 上游 dsh 端口（默认 3080）
 * @param {string} opts.token        访问令牌（16 字节随机，base64url）
 * @param {(msg: string) => void} [opts.onLog] 日志回调
 * @returns {Promise<{server: import('http').Server, port: number}>}
 */
function createLanProxy({ port, upstreamPort = 3080, token, onLog = () => {} }) {
  const log = (msg) => onLog(`[lan-proxy] ${msg}`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const client = req.socket.remoteAddress;

    // ── 令牌校验：query ?token= / Authorization: Bearer / cookie lan_token ──
    const cookie = parseCookies(req.headers.cookie || '');
    const qToken = url.searchParams.get('token');
    const bearer = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const got = qToken || bearer || cookie.lan_token;

    if (!got || !timingSafeEqualStr(got, token)) {
      log(`拒绝 ${client}（无有效令牌）`);
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FORBIDDEN_HTML);
      return;
    }

    // 首次带 ?token= 访问 → 种 cookie，之后自动携带
    const setCookie = qToken && !cookie.lan_token
      ? [`lan_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`]
      : undefined;

    // 去掉 query 里的 token，避免泄漏给上游
    url.searchParams.delete('token');
    const forwardPath = url.pathname + (url.search ? url.search : '');

    // ── 转发：重写 Host/Origin，让 dsh 信任围栏通过 ──
    const upstreamHost = '127.0.0.1';
    const headers = { ...req.headers };
    headers.host = `${upstreamHost}:${upstreamPort}`;
    if (headers.origin) headers.origin = `http://${upstreamHost}:${upstreamPort}`;
    delete headers['proxy-connection'];

    const proxyReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: forwardPath,
      headers,
    }, (proxyRes) => {
      log(`${req.method} ${forwardPath} → ${proxyRes.statusCode} (${client})`);
      const resHeaders = { ...proxyRes.headers };
      if (setCookie) resHeaders['set-cookie'] = (resHeaders['set-cookie'] || []).concat(setCookie);
      const ctype = String(proxyRes.headers['content-type'] || '');
      if (ctype.includes('text/html') && proxyRes.statusCode === 200) {
        // HTML 强制 no-store：注入层随版本变化，不能让 WKWebView 用旧页面
        resHeaders['cache-control'] = 'no-store';
        // 注入客户端增强层（randomUUID 补丁 + 移动端适配）
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          if (!html.includes('dsh-lan-polyfill') || !html.includes('dsh-mobile-layer')) {
            html = html.replace(/<head[^>]*>/i, (m) => m + buildInjection());
          }
          delete resHeaders['content-length'];
          res.writeHead(proxyRes.statusCode, resHeaders);
          res.end(html);
        });
        proxyRes.on('error', () => res.destroy());
      } else if (ctype.includes('text/event-stream')) {
        // SSE 流：注入心跳注释行（SSE 标准，客户端忽略 `:` 行），防止 iOS/网络
        // 把空闲连接掐断——手机事件流之前每 15~30s 掉线，消息不同步+审批卡片收不到。
        res.writeHead(proxyRes.statusCode, resHeaders);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': dsh-ping\n\n');
        }, 10000);
        proxyRes.on('data', (c) => { if (!res.writableEnded) res.write(c); });
        proxyRes.on('end', () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); });
        proxyRes.on('error', () => { clearInterval(heartbeat); res.destroy(); });
        // 客户端断开 → 回收上游连接（防泄漏）
        res.on('close', () => { clearInterval(heartbeat); proxyRes.destroy(); });
      } else {
        delete resHeaders['content-length']; // 流式转发
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
        // 客户端断开 → 回收上游连接（防泄漏）
        res.on('close', () => proxyRes.destroy());
      }
    });

    proxyReq.on('error', (err) => {
      log(`转发错误: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('502: 无法连接本机 DSH 服务（' + err.message + '）');
      } else {
        res.destroy();
      }
    });

    req.on('error', () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      log(`监听 0.0.0.0:${server.address().port}（令牌门禁已启用）`);
      resolve({ server, port: server.address().port });
    });
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function randomToken() {
  return crypto.randomBytes(16).toString('base64url');
}

module.exports = { createLanProxy, randomToken };
