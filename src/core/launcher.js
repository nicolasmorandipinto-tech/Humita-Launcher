const { spawn }  = require('child_process')
const fs         = require('fs')
const path       = require('path')
const os         = require('os')

const config     = require('../utils/config')
const javaFinder = require('../utils/javaFinder')

let _process = null

async function launch(versionId, onLog) {
  try {
    const mcDir       = config.minecraftDir
    const versionsDir = path.join(mcDir, 'versions', versionId)
    const metaPath    = path.join(versionsDir, `${versionId}.json`)

    if (!fs.existsSync(metaPath)) {
      return { success: false, message: `Versión ${versionId} no está instalada.` }
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    const javaPath = config.get('javaPath') || javaFinder.findJava()
    if (!javaPath) {
      return { success: false, message: 'Java no encontrado. Configúralo en Ajustes.' }
    }

    const args = buildArgs(javaPath, metadata, versionId, mcDir)

    onLog(`[INFO] Iniciando Minecraft ${versionId}...`)
    onLog(`[JAVA] ${javaPath}`)

    _process = spawn(args[0], args.slice(1), {
      cwd:   mcDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    _process.stdout.on('data', d => onLog(d.toString().trim()))
    _process.stderr.on('data', d => onLog(d.toString().trim()))

    return new Promise((resolve) => {
      _process.on('close', code => {
        _process = null
        onLog(`[INFO] Minecraft cerrado (código: ${code})`)
        resolve({ success: true, exitCode: code })
      })
      _process.on('error', err => {
        _process = null
        resolve({ success: false, message: err.message })
      })
    })

  } catch (err) {
    return { success: false, message: err.message }
  }
}

function buildArgs(javaPath, metadata, versionId, mcDir) {
  const ramMin = config.get('ramMin') || '1G'
  const ramMax = config.get('ramMax') || '2G'

  const username    = config.get('username')    || 'Player'
  const uuid        = config.get('uuid')        || '00000000-0000-0000-0000-000000000000'
  const accessToken = config.get('accessToken') || 'offline'
  const authType    = config.get('authType')    || 'offline'

  const versionsDir = path.join(mcDir, 'versions', versionId)
  const libsDir     = path.join(mcDir, 'libraries')
  const assetsDir   = path.join(mcDir, 'assets')
  const nativesDir  = path.join(versionsDir, 'natives')
  const mainClass   = metadata.mainClass || 'net.minecraft.client.main.Main'
  const assetIndex  = metadata.assetIndex?.id || versionId

  const sep       = os.platform() === 'win32' ? ';' : ':'
  const classpath = buildClasspath(metadata, libsDir, versionsDir, versionId, sep)

  return [
    javaPath,
    `-Xms${ramMin}`,
    `-Xmx${ramMax}`,
    `-Djava.library.path=${nativesDir}`,
    '-cp', classpath,
    mainClass,
    '--username',    username,
    '--version',     versionId,
    '--gameDir',     mcDir,
    '--assetsDir',   assetsDir,
    '--assetIndex',  assetIndex,
    '--uuid',        uuid,
    '--accessToken', accessToken,
    '--userType',    authType === 'microsoft' ? 'msa' : 'legacy',
  ]
}

function buildClasspath(metadata, libsDir, versionsDir, versionId, sep) {
  const paths = []

  for (const lib of metadata.libraries || []) {
    const artifact = lib.downloads?.artifact
    if (!artifact) continue
    const p = path.join(libsDir, artifact.path)
    if (fs.existsSync(p)) paths.push(p)
  }

  const clientJar = path.join(versionsDir, `${versionId}.jar`)
  if (fs.existsSync(clientJar)) paths.push(clientJar)

  return paths.join(sep)
}

function kill() {
  if (_process) {
    _process.kill()
    _process = null
  }
}

module.exports = { launch, kill }
