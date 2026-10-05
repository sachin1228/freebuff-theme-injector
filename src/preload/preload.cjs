'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('app:status'),
  enable: () => ipcRenderer.invoke('app:enable'),
  disable: () => ipcRenderer.invoke('app:disable'),
  perfGet: () => ipcRenderer.invoke('perf:get'),
  perfSet: (patch) => ipcRenderer.invoke('perf:set', patch),
  adsGet: () => ipcRenderer.invoke('ads:get'),
  adsSet: (patch) => ipcRenderer.invoke('ads:set', patch),
  byokStatus: () => ipcRenderer.invoke('byok:status'),
  byokSetup: () => ipcRenderer.invoke('byok:setup'),
  byokValidate: () => ipcRenderer.invoke('byok:validate'),
  benchRun: (opts) => ipcRenderer.invoke('bench:run', opts),
})
