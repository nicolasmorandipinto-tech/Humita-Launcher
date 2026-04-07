const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Window
  window: {
    minimize:    ()  => ipcRenderer.send('window:minimize'),
    maximize:    ()  => ipcRenderer.send('window:maximize'),
    close:       ()  => ipcRenderer.send('window:close'),
    isMaximized: ()  => ipcRenderer.invoke('window:isMaximized'),
  },

  // Config
  config: {
    get:    (key)        => ipcRenderer.invoke('config:get', key),
    set:    (key, value) => ipcRenderer.invoke('config:set', key, value),
    getAll: ()           => ipcRenderer.invoke('config:getAll'),
  },

  // Auth
  auth: {
    loginOffline:   (username) => ipcRenderer.invoke('auth:loginOffline', username),
    loginMicrosoft: ()         => ipcRenderer.invoke('auth:loginMicrosoft'),
    refresh:        ()         => ipcRenderer.invoke('auth:refresh'),
    logout:         ()         => ipcRenderer.invoke('auth:logout'),
  },

  // Versions
  versions: {
    fetch:       (snapshots) => ipcRenderer.invoke('versions:fetch', snapshots),
    isInstalled: (id)        => ipcRenderer.invoke('versions:isInstalled', id),
  },

  // Installer
  installer: {
    install:    (id) => ipcRenderer.invoke('installer:install', id),
    onProgress: (cb) => ipcRenderer.on('installer:progress', (_, d) => cb(d)),
  },

  // Launcher
  launcher: {
    launch: (id) => ipcRenderer.invoke('launcher:launch', id),
    kill:   ()   => ipcRenderer.invoke('launcher:kill'),
    onLog:  (cb) => ipcRenderer.on('launcher:log', (_, line) => cb(line)),
  },

  // Java
  java: {
    find:       ()     => ipcRenderer.invoke('java:find'),
    getVersion: (path) => ipcRenderer.invoke('java:getVersion', path),
  },

  // Shell
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  },
})
