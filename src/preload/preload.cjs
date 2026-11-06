'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('app:status'),
  open: () => ipcRenderer.invoke('app:open'),
})
