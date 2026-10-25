const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dayanApp', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  showWindow: () => ipcRenderer.invoke('app:show'),
  getPrinters: () => ipcRenderer.invoke('printers:get'),
  setPrinters: (cfg) => ipcRenderer.invoke('printers:set', cfg),
  testPrinter: (cfg) => ipcRenderer.invoke('printers:test', cfg),
  discoverPrinters: () => ipcRenderer.invoke('printers:discover'),
  onPrinters: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('printers:status', handler);
    return () => ipcRenderer.removeListener('printers:status', handler);
  }
});
