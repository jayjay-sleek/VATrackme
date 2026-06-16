const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  getIdleSeconds: () => ipcRenderer.invoke('desktop:get-idle-seconds'),
  captureScreen: () => ipcRenderer.invoke('desktop:capture-screen'),
  getActiveWindow: () => ipcRenderer.invoke('desktop:get-active-window'),
  apiRequest: (request) => ipcRenderer.invoke('api:request', request),
  pingApi: () => ipcRenderer.invoke('desktop:ping-api'),
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
  setIdlePopupActive: (options) => ipcRenderer.invoke('desktop:set-idle-popup', options),
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-for-update'),
  downloadUpdate: (downloadUrl) => ipcRenderer.invoke('desktop:download-update', downloadUrl),
});
