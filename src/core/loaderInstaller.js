/**
 * core/loaderInstaller.js
 *
 * Instala Fabric o Forge para una versión de Minecraft dada.
 *
 * Fabric:
 *   - Usa la API oficial de FabricMC (meta.fabricmc.net)
 *   - Descarga el profile JSON del loader y lo fusiona con el vanilla
 *   - Descarga las librerías extra que indica el profile
 *
 * Forge:
 *   - Descarga el installer JAR desde files.minecraftforge.net
 *   - Lo ejecuta en modo headless (--installClient) con el Java configurado
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const { spawnSync, spawn } = require('child_process')

const config     = require('../utils/config')
const { fetchJSON, download, downloadWithRetry, friendlyError } = require('../utils/http')

// ─── URLs de APIs ─────────────────────────────────────────────

const FABRIC_META  = 'https://meta.fabricmc.net/v2'
const FORGE_FILES  = 'https://maven.minecraftforge.net/net/minecraftforge/forge'

// ─── Helper: spawn asíncrono ──────────────────────────────────

/**
 * FIX 4: ejecuta un proceso con spawn() en vez de spawnSync() para no
 * bloquear el hilo principal de Electron durante la instalación de Forge
 * (que puede tardar varios minutos).
 */
function spawnAsync(cmd, args, options = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })

    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Tiempo de espera agotado (${timeoutMs / 1000}s) ejecutando el instalador`))
    }, timeoutMs)

    child.on('close', code => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ─── Fabric ───────────────────────────────────────────────────

/**
 * Instala Fabric loader para una versión de Minecraft.
 * @param {string} mcVersion       - ej: "1.21.4"
 * @param {string} loaderVersion   - ej: "0.16.10"
 * @param {function} onProgress    - cb({ message, percent })
 * @param {number} basePercent     - porcentaje base para los reportes (0-100)
 * @returns {Promise<{ success: boolean, versionId?: string, message?: string }>}
 */
async function installFabric(mcVersion, loaderVersion, onProgress, basePercent = 0) {
  try {
    onProgress({ message: `Descargando perfil Fabric ${loaderVersion}...`, percent: basePercent + 2 })

    // 1. Obtener el profile JSON del loader desde la API de Fabric
    const profileUrl = `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`
    let profile
    try {
      profile = await fetchJSON(profileUrl)
    } catch (err) {
      return {
        success: false,
        message: `No se pudo obtener el perfil de Fabric ${loaderVersion} para MC ${mcVersion}. ` +
                 `Verifica que la versión del loader sea correcta. (${friendlyError(err)})`,
      }
    }

    // El versionId de Fabric tiene el formato: "fabric-loader-<loaderVersion>-<mcVersion>"
    const versionId   = profile.id
    const mcDir       = config.minecraftDir
    const versionsDir = path.join(mcDir, 'versions', versionId)
    fs.mkdirSync(versionsDir, { recursive: true })

    // 2. Guardar el profile JSON en la carpeta de versiones
    const profilePath = path.join(versionsDir, `${versionId}.json`)
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2))

    onProgress({ message: `Perfil Fabric guardado ✓`, percent: basePercent + 5 })

    // 3. Descargar las librerías extra que indica el profile de Fabric
    const libs    = (profile.libraries || []).filter(l => l.url || l.downloads?.artifact)
    const libsDir = path.join(mcDir, 'libraries')

    if (libs.length > 0) {
      onProgress({ message: `Descargando ${libs.length} librerías de Fabric...`, percent: basePercent + 8 })

      let done       = 0
      const errors   = []

      await parallelLimit(libs.map(lib => async () => {
        const libPath = resolveLibPath(lib, libsDir)
        if (!libPath) { done++; return }

        if (fs.existsSync(libPath)) { done++; return }

        const libUrl = resolveLibUrl(lib)
        if (!libUrl) { done++; return }

        fs.mkdirSync(path.dirname(libPath), { recursive: true })

        try {
          await downloadWithRetry(libUrl, libPath)
        } catch (err) {
          errors.push({ name: lib.name, error: friendlyError(err) })
        }

        done++
        if (done % 5 === 0 || done === libs.length) {
          onProgress({
            message: `Librerías Fabric: ${done}/${libs.length}`,
            percent: basePercent + 8 + Math.floor((done / libs.length) * 10),
          })
        }
      }), 8)

      if (errors.length > 0) {
        console.warn('[loaderInstaller] Librerías Fabric con error:', errors)
      }
    }

    onProgress({ message: `Fabric ${loaderVersion} instalado ✓`, percent: basePercent + 20 })

    return { success: true, versionId }

  } catch (err) {
    return { success: false, message: `Error instalando Fabric: ${friendlyError(err)}` }
  }
}

// ─── Forge ────────────────────────────────────────────────────

/**
 * Instala Forge para una versión de Minecraft.
 * @param {string} mcVersion       - ej: "1.20.1"
 * @param {string} forgeVersion    - ej: "47.3.0"
 * @param {function} onProgress    - cb({ message, percent })
 * @param {number} basePercent
 * @returns {Promise<{ success: boolean, versionId?: string, message?: string }>}
 */
async function installForge(mcVersion, forgeVersion, onProgress, basePercent = 0) {
  try {
    // El versionId de Forge: "1.20.1-forge-47.3.0"
    const fullVersion = `${mcVersion}-${forgeVersion}`
    const versionId   = `${mcVersion}-forge-${forgeVersion}`
    const mcDir       = config.minecraftDir

    // Verificar si ya está instalado
    const versionsDir = path.join(mcDir, 'versions', versionId)
    const profilePath = path.join(versionsDir, `${versionId}.json`)
    if (fs.existsSync(profilePath)) {
      onProgress({ message: `Forge ${forgeVersion} ya instalado ✓`, percent: basePercent + 20 })
      return { success: true, versionId }
    }

    // 1. Descargar el installer JAR de Forge
    const installerUrl = `${FORGE_FILES}/${fullVersion}/forge-${fullVersion}-installer.jar`
    const tmpDir       = path.join(os.tmpdir(), 'humita-forge')
    fs.mkdirSync(tmpDir, { recursive: true })
    const installerJar = path.join(tmpDir, `forge-${fullVersion}-installer.jar`)

    onProgress({ message: `Descargando instalador de Forge ${forgeVersion}...`, percent: basePercent + 2 })

    try {
      await downloadWithRetry(installerUrl, installerJar)
    } catch (err) {
      return {
        success: false,
        message: `No se pudo descargar el instalador de Forge ${forgeVersion} para MC ${mcVersion}. ` +
                 `Verifica que la versión sea correcta. (${friendlyError(err)})`,
      }
    }

    onProgress({ message: `Instalador de Forge descargado. Ejecutando instalación...`, percent: basePercent + 10 })

    // 2. Obtener ruta de Java
    const javaPath = config.get('javaPath') || findJavaSync()
    if (!javaPath) {
      return { success: false, message: 'Java no encontrado. Configúralo en Ajustes antes de instalar Forge.' }
    }

    // 3. Ejecutar el installer en modo headless (asíncrono — FIX 4)
    let result
    try {
      result = await spawnAsync(
        javaPath,
        ['-jar', installerJar, '--installClient', mcDir],
        { cwd: mcDir },
        300000,
      )
    } catch (err) {
      try { fs.unlinkSync(installerJar) } catch { /* no crítico */ }
      return { success: false, message: `Error ejecutando el instalador de Forge: ${err.message}` }
    }

    // Limpiar el installer temporal
    try { fs.unlinkSync(installerJar) } catch { /* no crítico */ }

    if (result.status !== 0) {
      const errOutput = (result.stderr || result.stdout || '').slice(0, 500)
      return {
        success: false,
        message: `El instalador de Forge falló (código ${result.status}). ` +
                 `Asegúrate de que Java 8+ esté configurado correctamente.\n${errOutput}`,
      }
    }

    onProgress({ message: `Forge ${forgeVersion} instalado ✓`, percent: basePercent + 20 })

    return { success: true, versionId }

  } catch (err) {
    return { success: false, message: `Error instalando Forge: ${friendlyError(err)}` }
  }
}

// ─── Helpers internos ─────────────────────────────────────────

/** Resuelve la ruta local de una librería de Fabric */
function resolveLibPath(lib, libsDir) {
  if (lib.downloads?.artifact?.path) {
    return path.join(libsDir, lib.downloads.artifact.path)
  }
  if (lib.name) {
    // Formato Maven: "group:artifact:version"
    const parts = lib.name.split(':')
    if (parts.length >= 3) {
      const [group, artifact, version] = parts
      const groupPath = group.replace(/\./g, '/')
      return path.join(libsDir, groupPath, artifact, version, `${artifact}-${version}.jar`)
    }
  }
  return null
}

/** Resuelve la URL de descarga de una librería de Fabric */
function resolveLibUrl(lib) {
  if (lib.downloads?.artifact?.url) return lib.downloads.artifact.url
  if (lib.url && lib.name) {
    const parts = lib.name.split(':')
    if (parts.length >= 3) {
      const [group, artifact, version] = parts
      const groupPath = group.replace(/\./g, '/')
      const base = lib.url.endsWith('/') ? lib.url : lib.url + '/'
      return `${base}${groupPath}/${artifact}/${version}/${artifact}-${version}.jar`
    }
  }
  return null
}

/** Parallel con límite de concurrencia */
async function parallelLimit(tasks, limit) {
  let index = 0
  async function worker() {
    while (index < tasks.length) {
      const i = index++
      await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

/** Busca Java de forma síncrona (solo para el installer de Forge) */
function findJavaSync() {
  try {
    const { spawnSync: ss } = require('child_process')
    const cmd = os.platform() === 'win32' ? 'where' : 'which'
    const res = ss(cmd, ['java'], { encoding: 'utf-8' })
    if (res.status === 0) return res.stdout.trim().split('\n')[0].trim()
  } catch { /* ignorar */ }
  return null
}

// ─── API pública ──────────────────────────────────────────────

/**
 * Instala el loader correcto según el campo `loader` del modpack.
 * @param {{ type: 'fabric'|'forge', version: string }} loader
 * @param {string} mcVersion
 * @param {function} onProgress
 * @param {number} basePercent
 * @returns {Promise<{ success: boolean, versionId?: string, message?: string }>}
 */
async function installLoader(loader, mcVersion, onProgress, basePercent = 0) {
  if (!loader || !loader.type || !loader.version) {
    return { success: false, message: 'El modpack no especifica un loader válido (type + version).' }
  }

  switch (loader.type.toLowerCase()) {
    case 'fabric':
      return installFabric(mcVersion, loader.version, onProgress, basePercent)
    case 'forge':
      return installForge(mcVersion, loader.version, onProgress, basePercent)
    default:
      return { success: false, message: `Loader desconocido: "${loader.type}". Solo se soporta "fabric" o "forge".` }
  }
}

module.exports = { installLoader, installFabric, installForge }
