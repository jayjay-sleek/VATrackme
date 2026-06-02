const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  getIdleSeconds: () => ipcRenderer.invoke('desktop:get-idle-seconds'),
  captureScreen: () => ipcRenderer.invoke('desktop:capture-screen'),
  getActiveWindow: () => ipcRenderer.invoke('desktop:get-active-window'),
  apiRequest: (request) => ipcRenderer.invoke('api:request', request),
  log: (payload) => {
    try {
      ipcRenderer.send('renderer-log', payload);
    } catch (e) {
      // swallow
    }
  },
  onGlobalInput: (cb) => {
    ipcRenderer.on('global-input', (_e, payload) => {
      try { cb(payload); } catch (e) {}
    });
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
});
