'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('app:status'),
  enable: () => ipcRenderer.invoke('app:enable'),
  disable: () => ipcRenderer.invoke('app:disable'),
})
