// 生成 DSH Desktop 应用图标（纯 Node，无第三方依赖）
// 输出：assets/icon.png (1024x1024)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// ── 工具函数 ────────────────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// 平滑边缘（抗锯齿）：x 在 [0,1] 内从 0 过渡到 1
const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

// 点到线段距离
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 圆环：中心 (cx,cy)，半径 r，线宽 w → 覆盖率 [0,1]
function ring(px, py, cx, cy, r, w) {
  const d = Math.hypot(px - cx, py - cy);
  return smooth((r + w / 2 - d) / 2) * smooth((d - (r - w / 2)) / 2);
}

// 实心圆
function disc(px, py, cx, cy, r) {
  return smooth((r - Math.hypot(px - cx, py - cy)) / 2);
}

// 线段
function line(px, py, ax, ay, bx, by, w) {
  return smooth((w / 2 - distToSegment(px, py, ax, ay, bx, by)) / 2);
}

// 圆角矩形蒙版
function roundedRectMask(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return smooth((r - Math.hypot(px - cx, py - cy)) / 2);
}

// ── 绘制 ────────────────────────────────────────────────────────────────────
function pixelColor(px, py) {
  const M = 40;            // 外边距
  const x0 = M, y0 = M, x1 = SIZE - M, y1 = SIZE - M;
  const rr = 210;          // 圆角半径

  // 背景：深色渐变 + 圆角蒙版
  const mask = roundedRectMask(px, py, x0, y0, x1, y1, rr);
  if (mask <= 0) return [0, 0, 0, 0];
  const t = py / SIZE;
  let r = 13 + 8 * t, g = 15 + 10 * t, b = 28 + 18 * t;

  const u = px / SIZE, v = py / SIZE;

  // 中心节点：青色圆环 + 白色核心
  const ncx = 0.5 * SIZE, ncy = 0.48 * SIZE;
  const core = disc(px, py, ncx, ncy, 150);
  const halo = ring(px, py, ncx, ncy, 235, 46);
  const halo2 = ring(px, py, ncx, ncy, 330, 14);

  // 四周小节点
  const sat = [
    [0.21, 0.22, 0x8b5cf6], // 紫
    [0.80, 0.25, 0xec4899], // 粉
    [0.24, 0.78, 0x3b82f6], // 蓝
    [0.79, 0.74, 0xf59e0b], // 橙
  ];

  // 连线（中心 → 各小节点）
  const edges = [[ncx, ncy], [ncx, ncy], [ncx, ncy], [ncx, ncy]];
  const ecol = [0x8b5cf6, 0xec4899, 0x3b82f6, 0xf59e0b];
  for (let i = 0; i < 4; i++) {
    const ex = sat[i][0] * SIZE, ey = sat[i][1] * SIZE;
    const lw = line(px, py, edges[i][0], edges[i][1], ex, ey, 16);
    const ec = ecol[i];
    r += lw * (((ec >> 16) & 0xff) - r) * 0.75;
    g += lw * (((ec >> 8) & 0xff) - g) * 0.75;
    b += lw * ((ec & 0xff) - b) * 0.75;
  }

  // 小节点
  for (let i = 0; i < 4; i++) {
    const sx = sat[i][0] * SIZE, sy = sat[i][1] * SIZE;
    const c = sat[i][2];
    const d = disc(px, py, sx, sy, 66);
    r += d * (((c >> 16) & 0xff) - r);
    g += d * (((c >> 8) & 0xff) - g);
    b += d * ((c & 0xff) - b);
    // 小节点内发光点
    const dot = disc(px, py, sx, sy, 22);
    r += dot * (255 - r);
    g += dot * (255 - g);
    b += dot * (255 - b);
  }

  // 中心核心 + 光环
  r += core * (255 - r);
  g += core * (255 - g);
  b += core * (255 - b);

  const cyan = [0x22, 0xd3, 0xee];
  r += halo * (cyan[0] - r);
  g += halo * (cyan[1] - g);
  b += halo * (cyan[2] - b);
  r += halo2 * (cyan[0] - r) * 0.85;
  g += halo2 * (cyan[1] - g) * 0.85;
  b += halo2 * (cyan[2] - b) * 0.85;

  // 底部微光
  const glow = disc(px, py, ncx, SIZE * 0.62, 300) * 0.12;
  r += glow * (0x22 - r);
  g += glow * (0xd3 - g);
  b += glow * (0xee - b);

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * mask)];
}

// ── PNG 编码 ────────────────────────────────────────────────────────────────
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

console.log(`渲染 ${SIZE}x${SIZE} 图标…`);
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixelColor(x + 0.5, y + 0.5);
    const i = (y * SIZE + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
}
const png = encodePNG(SIZE, SIZE, rgba);
const out = path.join(outDir, 'icon.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${(png.length / 1024).toFixed(1)} KB）`);
