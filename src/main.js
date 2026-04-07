const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const isDev = process.argv.includes('--dev')

const authManager     = require('./core/auth')
const versionManager  = require('./core/versionManager')
const installer       = require('./core/installer')
const gameLauncher    = require('./core/launcher')
const config          = require('./utils/config')
const javaFinder      = require('./utils/javaFinder')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 620,
    minWidth: 960,
    minHeight: 620,
    maxWidth: 960,
    maxHeight: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
  })

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'))

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Window controls ──────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow.minimize())
ipcMain.on('window:close', () => mainWindow.close())

// ─── Config ───────────────────────────────────────────────────
ipcMain.handle('config:get', (_, key) => config.get(key))
ipcMain.handle('config:set', (_, key, value) => { config.set(key, value) })
ipcMain.handle('config:getAll', () => config.store)

// ─── Auth ─────────────────────────────────────────────────────
ipcMain.handle('auth:loginOffline', async (_, username) => {
  return await authManager.loginOffline(username)
})

ipcMain.handle('auth:loginMicrosoft', async () => {
  return await authManager.loginMicrosoft((event, data) => {
    mainWindow.webContents.send('auth:deviceCode', data)
  })
})

ipcMain.handle('auth:logout', () => {
  return authManager.logout()
})

// ─── Versions ─────────────────────────────────────────────────
ipcMain.handle('versions:fetch', async (_, includeSnapshots) => {
  return await versionManager.fetchVersions(includeSnapshots)
})

ipcMain.handle('versions:isInstalled', (_, versionId) => {
  return versionManager.isInstalled(versionId)
})

// ─── Installer ────────────────────────────────────────────────
ipcMain.handle('installer:install', async (_, versionId) => {
  return await installer.install(versionId, (progress) => {
    mainWindow.webContents.send('installer:progress', progress)
  })
})

// ─── Launcher ─────────────────────────────────────────────────
ipcMain.handle('launcher:launch', async (_, versionId) => {
  return await gameLauncher.launch(versionId, (line) => {
    mainWindow.webContents.send('launcher:log', line)
  })
})

ipcMain.handle('launcher:kill', () => gameLauncher.kill())

// ─── Java ─────────────────────────────────────────────────────
ipcMain.handle('java:find', async () => javaFinder.findJava())
ipcMain.handle('java:getVersion', async (_, javaPath) => javaFinder.getVersion(javaPath))

// ─── External links ───────────────────────────────────────────
ipcMain.on('shell:openExternal', (_, url) => shell.openExternal(url))
