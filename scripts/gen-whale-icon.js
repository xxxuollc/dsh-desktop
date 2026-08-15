// 从官方 favicon.svg（黑鲸）生成 1024x1024 应用图标
// 纯 Node：SVG 路径 → 扫描线光栅化(8x 超采样, even-odd) → 浅色圆角底 + 黑鲸合成
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 8;                      // 超采样倍数
const RS = SIZE * SS;              // 光栅化分辨率 8192
const TOL = 2.0;                   // 曲线平坦度阈值（像素，RS 尺度）

// ── SVG 路径解析（仅需支持 M / L / C / Z，兼容大小写→按绝对坐标处理）────────
const SCALE = RS / 50; // 源 SVG viewBox 为 50x50，放大到光栅化尺度
const S = (v) => v * SCALE;

function parsePath(d) {
  const re = /([MmLlCcZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const segments = [];   // {type:'M'|'L'|'C', pts:[x0,y0,...]}
  let m, cmd = null, params = [];
  const cur = { x: 0, y: 0, sx: 0, sy: 0 };

  const flush = () => {
    if (!cmd) return;
    if (cmd === 'M' && params.length >= 2) {
      cur.x = S(params[0]); cur.y = S(params[1]);
      cur.sx = cur.x; cur.sy = cur.y;
      segments.push({ type: 'M', x: cur.x, y: cur.y });
      params = params.slice(2);
      cmd = 'L'; // 后续隐式参数按连线处理
    } else if (cmd === 'L' && params.length >= 2) {
      segments.push({ type: 'L', x0: cur.x, y0: cur.y, x1: S(params[0]), y1: S(params[1]) });
      cur.x = S(params[0]); cur.y = S(params[1]);
      params = params.slice(2);
    } else if (cmd === 'C' && params.length >= 6) {
      segments.push({
        type: 'C',
        x0: cur.x, y0: cur.y,
        x1: S(params[0]), y1: S(params[1]),
        x2: S(params[2]), y2: S(params[3]),
        x3: S(params[4]), y3: S(params[5]),
      });
      cur.x = S(params[4]); cur.y = S(params[5]);
      params = params.slice(6);
    } else if (cmd === 'Z') {
      segments.push({ type: 'Z', x0: cur.x, y0: cur.y, x1: cur.sx, y1: cur.sy });
      cur.x = cur.sx; cur.y = cur.sy;
      params = [];
    }
  };

  while ((m = re.exec(d))) {
    if (m[1]) {
      flush();
      cmd = m[1].toUpperCase();
      params = [];
    } else {
      params.push(parseFloat(m[2]));
      if (cmd) flush();
    }
  }
  flush();
  return segments;
}

// ── 曲线平坦化 → 线段，按 y 分桶 ───────────────────────────────────────────
function flatten(segments) {
  const buckets = new Map(); // y 索引(0..RS-1) → [{x1,y1,x2,y2}]
  const addSeg = (x1, y1, x2, y2) => {
    const ymin = Math.min(y1, y2), ymax = Math.max(y1, y2);
    const a = Math.max(0, Math.floor(ymin));
    const b = Math.min(RS - 1, Math.floor(ymax));
    for (let y = a; y <= b; y++) {
      let list = buckets.get(y);
      if (!list) { list = []; buckets.set(y, list); }
      list.push({ x1, y1, x2, y2 });
    }
  };

  const flattenCurve = (s) => {
    const stack = [[s.x0, s.y0, s.x1, s.y1, s.x2, s.y2, s.x3, s.y3]];
    while (stack.length) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = stack.pop();
      const flat = Math.abs((x1 + x2) / 2 - (x0 + x3) / 2) + Math.abs((y1 + y2) / 2 - (y0 + y3) / 2) < TOL;
      if (flat) {
        addSeg(x0, y0, x3, y3);
      } else {
        const mx = (x0 + 3 * (x1 + x2) + x3) / 8, my = (y0 + 3 * (y1 + y2) + y3) / 8;
        const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
        const bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
        const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
        const abx = (ax + bx) / 2, aby = (ay + by) / 2;
        const bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
        stack.push([x0, y0, ax, ay, abx, aby, mx, my]);
        stack.push([mx, my, bcx, bcy, cx, cy, x3, y3]);
      }
    }
  };

  for (const s of segments) {
    if (s.type === 'L' || s.type === 'Z') addSeg(s.x0, s.y0, s.x1, s.y1);
    else if (s.type === 'C') flattenCurve(s);
  }
  return buckets;
}

// ── 扫描线 even-odd 填充（8x 超采样二值图）─────────────────────────────────
function render(buckets) {
  const row = new Float64Array(RS); // 每行交点 x
  const bitmap = new Uint8Array(RS * RS);
  for (let y = 0; y < RS; y++) {
    const list = buckets.get(y);
    if (!list || !list.length) continue;
    let n = 0;
    for (const seg of list) {
      const dy = seg.y2 - seg.y1;
      if (dy === 0) continue;
      const t = (y + 0.5 - seg.y1) / dy;
      if (t <= 0 || t >= 1) continue;
      row[n++] = seg.x1 + t * (seg.x2 - seg.x1);
    }
    if (n < 2) continue;
    row.subarray(0, n).sort();
    const base = y * RS;
    let inside = false;
    for (let i = 0; i < n - 1; i++) {
      inside = !inside;
      if (!inside) continue;
      let xa = Math.ceil(row[i]);
      let xb = Math.floor(row[i + 1]);
      if (xa < 0) xa = 0;
      if (xb > RS - 1) xb = RS - 1;
      for (let x = xa; x <= xb; x++) bitmap[base + x] = 1;
    }
  }
  return bitmap;
}

// ── 降采样 → 1024 alpha ────────────────────────────────────────────────────
function downsample(bitmap) {
  const alpha = new Float32Array(SIZE * SIZE);
  for (let by = 0; by < SIZE; by++) {
    for (let bx = 0; bx < SIZE; bx++) {
      let sum = 0;
      const base = (by * SS) * RS + bx * SS;
      for (let dy = 0; dy < SS; dy++) {
        const r = base + dy * RS;
        for (let dx = 0; dx < SS; dx++) sum += bitmap[r + dx];
      }
      alpha[by * SIZE + bx] = sum / (SS * SS);
    }
  }
  return alpha;
}

// ── 鲸鱼包围盒（用于放置）──────────────────────────────────────────────────
function whaleBBox(alpha) {
  let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (alpha[y * SIZE + x] > 0.01) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// ── 合成 1024 图标 ──────────────────────────────────────────────────────────
function smooth(x) { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); }

function compose(whaleAlpha, bbox) {
  const M = 48;            // 圆角矩形外边距
  const rr = 216;          // 圆角半径
  const W = 1024;
  const out = Buffer.alloc(W * W * 4);

  // 鲸鱼目标宽度：画布 62%；竖直居中略偏上
  const targetW = W * 0.62;
  const scale = targetW / (bbox.maxX - bbox.minX);
  const ww = (bbox.maxX - bbox.minX) * scale;
  const wh = (bbox.maxY - bbox.minY) * scale;
  const ox = (W - ww) / 2 - bbox.minX * scale;
  const oy = (W - wh) / 2 - 0.02 * W - bbox.minY * scale; // 视觉中心略偏上

  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      // 圆角矩形蒙版
      const cx = Math.min(Math.max(px, M + rr), W - M - rr);
      const cy = Math.min(Math.max(py, M + rr), W - M - rr);
      const bgMask = smooth((rr - Math.hypot(px - cx, py - cy)) / 2);
      if (bgMask <= 0) continue;

      // 浅色渐变底（顶白 → 底浅蓝灰）
      const t = py / W;
      let r = 255 + (230 - 255) * t;
      let g = 255 + (236 - 255) * t;
      let b = 255 + (245 - 255) * t;

      // 黑鲸
      const sx = (px - ox) / scale;
      const sy = (py - oy) / scale;
      if (sx >= 0 && sy >= 0 && sx < W && sy < W) {
        const i = Math.floor(sy) * W + Math.floor(sx);
        const a = whaleAlpha[i];
        if (a > 0.004) {
          const k = a;
          r = r * (1 - k);
          g = g * (1 - k);
          b = b * (1 - k);
        }
      }

      const o = (py * W + px) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(255 * bgMask);
    }
  }
  return out;
}

// ── PNG 编码（与 gen-icon.js 相同）──────────────────────────────────────────
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
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0, 0);
    return Buffer.concat([len, tb, data, crc]);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── ASCII 预览（验证鲸鱼形状）───────────────────────────────────────────────
function asciiPreview(alpha, bbox) {
  const W = 48, H = 20;
  const lines = [];
  for (let hy = 0; hy < H; hy++) {
    let line = '';
    for (let hx = 0; hx < W; hx++) {
      const x = bbox.minX + ((hx + 0.5) / W) * (bbox.maxX - bbox.minX);
      const y = bbox.minY + ((hy + 0.5) / H) * (bbox.maxY - bbox.minY);
      const i = Math.floor(y) * SIZE + Math.floor(x);
      line += alpha[i] > 0.5 ? '#' : (alpha[i] > 0.1 ? '+' : ' ');
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon-whale.svg'), 'utf8');
const d = svg.match(/\sd="([^"]+)"/)[1];

console.log('解析路径…');
const segments = parsePath(d);
console.log(`  段数: M=${segments.filter(s => s.type === 'M').length} C=${segments.filter(s => s.type === 'C').length} L/Z=${segments.filter(s => s.type !== 'M' && s.type !== 'C').length}`);

console.log(`平坦化（${RS}px, tol=${TOL}）…`);
const buckets = flatten(segments);
const segCount = [...buckets.values()].reduce((n, l) => n + l.length, 0);
console.log(`  线段分桶: ${buckets.size} 行 / ${segCount} 段`);

console.log('扫描线填充…');
const bitmap = render(buckets);

console.log('降采样 → 1024 alpha…');
const alpha = downsample(bitmap);

const bbox = whaleBBox(alpha);
console.log(`鲸鱼包围盒: x[${bbox.minX},${bbox.maxX}] y[${bbox.minY},${bbox.maxY}] (${bbox.maxX - bbox.minX}x${bbox.maxY - bbox.minY}px)`);

console.log('\nASCII 预览:');
console.log(asciiPreview(alpha, bbox));

console.log('\n合成图标…');
const rgba = compose(alpha, bbox);
const png = encodePNG(SIZE, SIZE, rgba);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${(png.length / 1024).toFixed(1)} KB）`);
