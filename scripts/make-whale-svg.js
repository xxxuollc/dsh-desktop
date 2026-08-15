// 从官方 favicon.svg 生成黑鲸素材：去掉深色模式媒体查询，路径强制填黑
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync('/tmp/dsh-logo/favicon.svg', 'utf8');

// 1. 去掉 <style> 块（含 prefers-color-scheme 媒体查询）
let svg = src.replace(/<style>[\s\S]*?<\/style>/g, '');

// 2. 给 path 注入 fill="#000000"（黑鲸）；若已有 fill 则替换
svg = svg.replace(/<path([^>]*?)>/, (m, attrs) => {
  if (/fill=/.test(attrs)) {
    return `<path${attrs.replace(/fill="[^"]*"/, 'fill="#000000"')}>`;
  }
  return `<path${attrs} fill="#000000">`;
});

const out = path.join(__dirname, '..', 'assets', 'icon-whale.svg');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log('已生成', out);
