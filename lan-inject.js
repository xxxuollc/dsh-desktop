// lan-inject.js — 经局域网代理注入到 DSH 页面的客户端增强层
// 1) crypto.randomUUID 补丁：LAN 是 http 不安全上下文，randomUUID 不可用，而 DSH 每条 RPC 都需要它
// 2) 移动端习惯适配层：侧栏左右滑动开合（手机习惯）+ 设置页窄屏堆叠（rail 转顶部横条）
//    全部 try/catch 保护：任何失败都不影响页面本身（这是代理层兜底，不触碰框架 bundle）
'use strict';

const POLYFILL = `<script>/*dsh-lan-polyfill*/(function(){try{if(!window.crypto||!window.crypto.getRandomValues)return;if(typeof window.crypto.randomUUID==="function")return;window.crypto.randomUUID=function(){var b=window.crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(v){return v.toString(16).padStart(2,"0")}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}catch(e){}})();</script>`;

const MOBILE_LAYER = `<script>/*dsh-mobile-layer*/(function(){try{
var mq=window.matchMedia("(max-width:767px)");
var isMobile=mq.matches;
if(mq.addEventListener)mq.addEventListener("change",function(){isMobile=mq.matches});else if(mq.addListener)mq.addListener(function(){isMobile=mq.matches});
var sx=0,sy=0,tracking=false;
document.addEventListener("touchstart",function(e){if(!isMobile)return;var t=e.changedTouches[0];sx=t.clientX;sy=t.clientY;tracking=true},{passive:true});
document.addEventListener("touchend",function(e){if(!tracking||!isMobile)return;tracking=false;var t=e.changedTouches[0];var dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy))return;if(dx>0)hit(true);else hit(false)},{passive:true});
function hit(open){var b=null;var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++){var a=(bs[i].getAttribute("aria-label")||"");if(a.indexOf("\\u4fa7\\u8fb9\\u680f")>=0&&((open&&a.indexOf("\\u6253\\u5f00")===0)||(!open&&a.indexOf("\\u6536\\u8d77")===0))){b=bs[i];break}}if(b)b.click()}
var st=document.createElement("style");
st.textContent="@media (max-width:767px){:root{--dsh-chat-content-width:calc(100vw - 20px) !important;--dsh-composer-side-clearance:12px !important}input,textarea{font-size:16px !important}.VOzbGW_rail{position:static !important;width:100% !important;height:auto !important;flex-direction:row !important;overflow-x:auto !important}.VOzbGW_navList{display:flex !important;flex-direction:row !important;overflow-x:auto !important}.VOzbGW_panel{width:100% !important;margin:0 !important}}";
document.head.appendChild(st);
}catch(e){}})();</script>`;

/** 组装注入片段：插到 <head> 之后，先于应用模块脚本执行。 */
function buildInjection() {
  return POLYFILL + MOBILE_LAYER;
}

module.exports = { buildInjection };
