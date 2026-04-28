/**
 * main.js
 * CAMBIOS:
 * - PUNTO 4:  auth.logout ahora es async
 * - PUNTO 7+12: launcher recibe modpackId para usar el gameDir correcto
 * - PUNTO 10: validación básica de parámetros en handlers IPC
 * - AUTO-UPDATER: integrado con electron-updater via GitHub Releases
 */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const isDev = process.argv.includes('--dev')

const authManager    = require('./core/auth')
const versionManager = require('./core/versionManager')
const installer      = require('./core/installer')
const gameLauncher   = require('./core/launcher')
const modpackManager = require('./core/modpackManager')
const config         = require('./utils/config')
const javaFinder     = require('./utils/javaFinder')

// ─── Configuración del auto-updater ───────────────────────────
// No descarga automático — el usuario decide cuándo descargar
autoUpdater.autoDownload = false
// Se instala al cerrar la app si ya fue descargado
autoUpdater.autoInstallOnAppQuit = true

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1280,
    minHeight: 720,
    maxWidth: 1280,
    maxHeight: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      disableBlinkFeatures: 'Auxclick',
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  })

  // --- CONFIGURACIÓN DE SEGURIDAD (EVENTOS) ---

  // 1. Bloquea que la ventana navegue a sitios web externos
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !isDev) {
      event.preventDefault()
    }
  })

  // 2. Gestiona la apertura de nuevas ventanas (links externos)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // --------------------------------------------

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'))
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()

  // Chequear actualizaciones solo en producción
  if (!isDev) {
    autoUpdater.checkForUpdates()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Helpers de validación ────────────────────────────────────

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Parámetro inválido: "${name}" debe ser un string no vacío`)
  }
}

// ─── Auto-updater eventos ─────────────────────────────────────

// Hay una nueva versión disponible
autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('updater:available', {
    version: info.version,
  })
})

// No hay actualizaciones
autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('updater:not-available')
})

// Progreso de descarga
autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('updater:progress', {
    percent:     Math.round(progress.percent),
    transferred: progress.transferred,
    total:       progress.total,
  })
})

// Descarga completada — listo para instalar
autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('updater:downloaded')
})

// Error en el updater (no crashea la app)
autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('updater:error', err.message)
})

// ─── Auto-updater handlers IPC ────────────────────────────────

// El renderer solicita iniciar la descarga
ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())

// El renderer solicita instalar y reiniciar
ipcMain.handle('updater:install',  () => autoUpdater.quitAndInstall())

// ─── Window controls ──────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:close',    () => mainWindow?.close())

// ─── Config ───────────────────────────────────────────────────
ipcMain.handle('config:get',    (_, key)        => config.get(key))
ipcMain.handle('config:set',    (_, key, value) => { config.set(key, value) })
ipcMain.handle('config:getAll', ()              => config.store)

// ─── Auth ─────────────────────────────────────────────────────
ipcMain.handle('auth:loginOffline', async (_, username) => {
  try {
    assertString(username, 'username')
    return await authManager.loginOffline(username)
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('auth:loginMicrosoft', async () => {
  return await authManager.loginMicrosoft()
})

ipcMain.handle('auth:refresh', async () => {
  return await authManager.refreshSession()
})

ipcMain.handle('auth:logout', async () => {
  return await authManager.logout()
})

// ─── Versions ─────────────────────────────────────────────────
ipcMain.handle('versions:fetch', async (_, includeSnapshots) => {
  return await versionManager.fetchVersions(Boolean(includeSnapshots))
})

ipcMain.handle('versions:isInstalled', (_, versionId) => {
  return versionManager.isInstalled(versionId)
})

// ─── Installer ────────────────────────────────────────────────
ipcMain.handle('installer:install', async (_, versionId) => {
  try {
    assertString(versionId, 'versionId')
    return await installer.install(versionId, (progress) => {
      mainWindow?.webContents.send('installer:progress', progress)
    })
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('installer:hasInterrupted', (_, versionId) => {
  const { hasInterruptedInstall } = require('./utils/installStateManager')
  return hasInterruptedInstall(versionId)
})

// ─── Launcher ─────────────────────────────────────────────────
ipcMain.handle('launcher:launch', async (_, versionId, serverIp, modpackId) => {
  try {
    assertString(versionId, 'versionId')
    return await gameLauncher.launch(versionId, serverIp, (line) => {
      mainWindow?.webContents.send('launcher:log', line)
    }, modpackId || null)
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('launcher:kill', () => gameLauncher.kill())

// ─── Java ─────────────────────────────────────────────────────
ipcMain.handle('java:find',       async ()           => javaFinder.findJava())
ipcMain.handle('java:getVersion', async (_, javaPath) => {
  try {
    assertString(javaPath, 'javaPath')
    return javaFinder.getVersion(javaPath)
  } catch {
    return 'Desconocida'
  }
})

// ─── Modpacks ─────────────────────────────────────────────────
ipcMain.handle('modpacks:fetch', async () => {
  return await modpackManager.fetchModpacks()
})

ipcMain.handle('modpacks:install', async (_, modpackId, modpackData) => {
  try {
    assertString(modpackId, 'modpackId')
    if (!modpackData || typeof modpackData !== 'object') {
      return { success: false, message: 'Datos del modpack inválidos.' }
    }
    return await modpackManager.installModpack(modpackId, modpackData, (progress) => {
      mainWindow?.webContents.send('modpacks:progress', progress)
    })
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('modpacks:isInstalled', (_, modpackId) => {
  return modpackManager.isInstalled(modpackId)
})

ipcMain.handle('modpacks:renameInstance', (_, modpackId, newName) => {
  try {
    assertString(modpackId, 'modpackId')
    assertString(newName,   'newName')
    const installed = config.get('installedModpacks') || {}
    if (!installed[modpackId]) return { success: false, message: 'Instancia no encontrada.' }
    installed[modpackId].name = newName.trim()
    config.set('installedModpacks', installed)
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('modpacks:deleteInstance', (_, modpackId) => {
  try {
    assertString(modpackId, 'modpackId')
    const installed = config.get('installedModpacks') || {}
    delete installed[modpackId]
    config.set('installedModpacks', installed)
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('app:version', () => {
  return app.getVersion()
})

// ─── Files ────────────────────────────────────────────────────
ipcMain.handle('files:copyOptions', async (_, srcPath, versionId) => {
  try {
    assertString(srcPath,   'srcPath')
    assertString(versionId, 'versionId')
    const fs   = require('fs')
    const path = require('path')
    const os   = require('os')
    const cfg  = require('./utils/config')

    const mcDir = cfg.get('minecraftDir') || path.join(os.homedir(), '.minecraft')
    const dest  = path.join(mcDir, 'options.txt')

    if (!fs.existsSync(srcPath)) {
      return { success: false, message: `Archivo no encontrado: ${srcPath}` }
    }
    fs.copyFileSync(srcPath, dest)
    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
})

// ─── System info ──────────────────────────────────────────────
ipcMain.handle('system:ramMb', () => {
  const os = require('os')
  return Math.floor(os.totalmem() / 1024 / 1024)
})

// ─── Shell ────────────────────────────────────────────────────
ipcMain.on('shell:openExternal', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url)
  }
})