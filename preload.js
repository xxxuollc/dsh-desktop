// preload.js — 局域网面板的安全桥（contextIsolation + sandbox 下只暴露最小 API）
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanAPI', {
  getState: () => ipcRenderer.invoke('lan:state'),
  setEnabled: (on) => ipcRenderer.invoke('lan:setEnabled', on),
  getAddresses: () => ipcRenderer.invoke('lan:addresses'),
  regenerateToken: () => ipcRenderer.invoke('lan:regenerateToken'),
  close: () => ipcRenderer.invoke('lan:close'),
});
