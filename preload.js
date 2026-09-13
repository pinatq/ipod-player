const { contextBridge, ipcRenderer } = require('electron');
const { wheelDelta, matchQuery, homeMenuLayout } = require('./lib');

contextBridge.exposeInMainWorld('ipod', {
  wheelDelta,
  matchQuery,
  homeMenuLayout,
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

  // strumieniowanie: YouTube Music i Spotify (ze Spotify tylko lista utworow)
  streamUrl: (t) => ipcRenderer.invoke('stream-url', t),
  downloadTrack: (t) => ipcRenderer.invoke('download-track', t),
  ytmStatus: () => ipcRenderer.invoke('ytm-status'),
  ytmLogin: () => ipcRenderer.invoke('ytm-login'),
  ytmUseSafari: () => ipcRenderer.invoke('ytm-use-safari'),
  ytmDisconnect: () => ipcRenderer.invoke('ytm-disconnect'),
  ytmPlaylists: () => ipcRenderer.invoke('ytm-playlists'),
  ytmTracks: (id) => ipcRenderer.invoke('ytm-tracks', id),
  ytmRadio: (id) => ipcRenderer.invoke('ytm-radio', id),
  spotifyStatus: () => ipcRenderer.invoke('spotify-status'),
  spotifySetId: (id) => ipcRenderer.invoke('spotify-set-id', id),
  spotifyLogin: () => ipcRenderer.invoke('spotify-login'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify-disconnect'),
  spotifyPlaylists: () => ipcRenderer.invoke('spotify-playlists'),
  spotifyTracks: (id) => ipcRenderer.invoke('spotify-tracks', id),
  spotifyLinkTracks: (url) => ipcRenderer.invoke('spotify-link-tracks', url),
});
