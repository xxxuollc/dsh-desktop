// lan-panel.js — 局域网面板逻辑（独立文件，配合 CSP script-src 'self'）
'use strict';

const $ = (id) => document.getElementById(id);
let token = '';

function renderAddresses(list) {
  const box = $('addrList');
  box.innerHTML = '';
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty">未找到局域网 IP（检查 Wi-Fi/网络连接）</div>';
    return;
  }
  for (const a of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="addr">
        <img src="${a.qr}" alt="二维码" />
        <div class="info">
          <div class="ip">${a.url.replace(/^https?:\/\//, '')}</div>
          <div class="hint">用手机相机/浏览器扫码打开</div>
          <button class="copyUrl" data-url="${a.url}">复制链接</button>
        </div>
      </div>`;
    box.appendChild(card);
  }
  for (const btn of box.querySelectorAll('.copyUrl')) {
    btn.addEventListener('click', () => copyText(btn.dataset.url));
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板受限时忽略 */ }
}

$('toggle').addEventListener('change', async (e) => {
  const r = await window.lanAPI.setEnabled(e.target.checked);
  if (r.error) { alert(r.error); e.target.checked = !e.target.checked; return; }
  $('tokenCard').classList.toggle('hide', !r.enabled);
  if (r.enabled) {
    token = r.token;
    $('tokenText').textContent = token;
    const addrs = await window.lanAPI.getAddresses();
    renderAddresses(addrs);
  } else {
    renderAddresses([]);
  }
});

$('copyToken').addEventListener('click', () => copyText(token));

$('regenerate').addEventListener('click', async () => {
  const r = await window.lanAPI.regenerateToken();
  token = r.token;
  $('tokenText').textContent = token;
  const addrs = await window.lanAPI.getAddresses();
  renderAddresses(addrs);
});

(async () => {
  const s = await window.lanAPI.getState();
  $('toggle').checked = s.enabled;
  $('tokenCard').classList.toggle('hide', !s.enabled);
  if (s.enabled) {
    token = s.token;
    $('tokenText').textContent = token;
    const addrs = await window.lanAPI.getAddresses();
    renderAddresses(addrs);
  }
})();
