// Preload script: isolated context, runs before the page.
// Explicit CommonJS, independent of the package's "type": "module".
'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('torrents:list'),
  addText: (text) => ipcRenderer.invoke('torrents:add-text', text),
  pickFiles: () => ipcRenderer.invoke('torrents:pick-files'),
  addPath: (filePath) => ipcRenderer.invoke('torrents:add-path', filePath),
  pause: (id) => ipcRenderer.invoke('torrents:pause', id),
  resume: (id) => ipcRenderer.invoke('torrents:resume', id),
  remove: (id, deleteFiles) => ipcRenderer.invoke('torrents:remove', id, deleteFiles),
  reveal: (id) => ipcRenderer.invoke('torrents:reveal', id),
  openFile: (id) => ipcRenderer.invoke('torrents:open', id),
  play: (id) => ipcRenderer.invoke('torrents:play', id),
  savePoster: (id, bytes) => ipcRenderer.invoke('posters:save', id, bytes),
  posterFailed: (id) => ipcRenderer.invoke('posters:failed', id),
  settings: () => ipcRenderer.invoke('settings:get'),
  chooseDownload: () => ipcRenderer.invoke('settings:choose-download'),
  openFolder: () => ipcRenderer.invoke('settings:open-folder'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onUpdate: (callback) => {
    const handler = (_event, list) => callback(list)
    ipcRenderer.on('torrents:update', handler)
    return () => ipcRenderer.removeListener('torrents:update', handler)
  },
  onFocus: (callback) => {
    const handler = (_event, id) => callback(id)
    ipcRenderer.on('torrents:focus', handler)
    return () => ipcRenderer.removeListener('torrents:focus', handler)
  },
  onError: (callback) => {
    const handler = (_event, message) => callback(message)
    ipcRenderer.on('app:error', handler)
    return () => ipcRenderer.removeListener('app:error', handler)
  }
})
