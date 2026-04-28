/**
 * preload.js
 * CAMBIOS ORIGINALES:
 * - PUNTO 2 (listeners): onProgress/onLog usan removeAllListeners antes de
 *   agregar el nuevo callback, evitando acumulación en sesiones largas
 * - PUNTO 7+12: launcher.launch ahora acepta modpackId
 * - PUNTO 4: auth.logout es async
 *
 * SECURITY FIX:
 * - SEC 7: config.set ya no está expuesto directamente al renderer.
 *   Solo las claves en RENDERER_WRITABLE_KEYS pueden ser modificadas
 *   desde la UI.
 *
 * AUTO-UPDATER:
 * - Expone updater al renderer para mostrar banners y controlar descarga/instalación
 */

const { contextBridge, ipcRenderer } = require('electron')

// SEC 7: claves de configuración que el renderer tiene permitido escribir.
const RENDERER_WRITABLE_KEYS = new Set([
  'ramMin',
  'ramMax',
  'minecraftDir',
  'lastServerIp',
  'lastVersion',
  'lastModpackId',
  'lastModpackName',
])

/**
 * Helper: registra un listener de evento IPC limpiando el anterior primero.
 * Evita que llamadas repetidas acumulen callbacks.
 */
function onChannel(channel, cb) {
  ipcRenderer.removeAllListeners(channel)
  ipcRenderer.on(channel, (_, data) => cb(data))
}

contextBridge.exposeInMainWorld('api', {

  // Window
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // Config
  config: {
    get:    (key)        => ipcRenderer.invoke('config:get', key),
    getAll: ()           => ipcRenderer.invoke('config:getAll'),
    set: (key, value) => {
      if (!RENDERER_WRITABLE_KEYS.has(key)) {
        console.warn(`[preload] config.set bloqueado — clave no permitida: "${key}"`)
        return Promise.resolve(undefined)
      }
      return ipcRenderer.invoke('config:set', key, value)
    },
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
    install:        (id)        => ipcRenderer.invoke('installer:install', id),
    hasInterrupted: (versionId) => ipcRenderer.invoke('installer:hasInterrupted', versionId),
    onProgress:     (cb)        => onChannel('installer:progress', cb),
  },

  // Launcher
  launcher: {
    launch: (id, serverIp, modpackId) =>
      ipcRenderer.invoke('launcher:launch', id, serverIp, modpackId),
    kill:  () => ipcRenderer.invoke('launcher:kill'),
    onLog: (cb) => onChannel('launcher:log', cb),
  },

  // Java
  java: {
    find:       ()     => ipcRenderer.invoke('java:find'),
    getVersion: (path) => ipcRenderer.invoke('java:getVersion', path),
  },

  // Modpacks
  modpacks: {
    fetch:          ()         => ipcRenderer.invoke('modpacks:fetch'),
    install:        (id, data) => ipcRenderer.invoke('modpacks:install', id, data),
    isInstalled:    (id)       => ipcRenderer.invoke('modpacks:isInstalled', id),
    renameInstance: (id, name) => ipcRenderer.invoke('modpacks:renameInstance', id, name),
    deleteInstance: (id)       => ipcRenderer.invoke('modpacks:deleteInstance', id),
    onProgress:     (cb)       => onChannel('modpacks:progress', cb),
  },

  // App info
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },

  // System info
  system: {
    ramMb: () => ipcRenderer.invoke('system:ramMb'),
  },

  // Shell
  shell: {
    openExternal: (url) => {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        ipcRenderer.send('shell:openExternal', url)
      } else {
        console.warn('[preload] openExternal bloqueado — URL no permitida:', url)
      }
    },
  },

  // Files
  files: {
    copyOptions: (srcPath, versionId) =>
      ipcRenderer.invoke('files:copyOptions', srcPath, versionId),
  },

  // Updater
  updater: {
    // Eventos que llegan desde main
    onAvailable:    (cb) => onChannel('updater:available',     cb), // { version }
    onNotAvailable: (cb) => onChannel('updater:not-available', cb),
    onProgress:     (cb) => onChannel('updater:progress',      cb), // { percent, transferred, total }
    onDownloaded:   (cb) => onChannel('updater:downloaded',    cb),
    onError:        (cb) => onChannel('updater:error',         cb), // mensaje string

    // Acciones
    download: () => ipcRenderer.invoke('updater:download'),
    install:  () => ipcRenderer.invoke('updater:install'),
  },
})