const { contextBridge, ipcRenderer } = require('electron');
const { wheelDelta } = require('./lib');

contextBridge.exposeInMainWorld('ipod', {
  wheelDelta,
  listTracks: () => ipcRenderer.invoke('list-tracks'),
  deleteTrack: (f) => ipcRenderer.invoke('delete-track', f),
  download: (url, video) => ipcRenderer.invoke('download', url, video),
  downloaderStatus: () => ipcRenderer.invoke('downloader-status'),
  language: () => ipcRenderer.invoke('language'),
  setLanguage: (l) => ipcRenderer.invoke('set-language', l),
  revealMusic: () => ipcRenderer.invoke('reveal-music'),
  quit: () => ipcRenderer.invoke('quit'),
  minimize: () => ipcRenderer.invoke('minimize'),
  onProgress: (cb) => ipcRenderer.on('download-progress', (_e, p) => cb(p)),
});
