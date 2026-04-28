/**
 * core/modpackManager.js
 *
 * CAMBIOS ORIGINALES:
 * - LOADER: si el modpack tiene campo `loader` (fabric/forge + version),
 *   se instala el loader automáticamente después del vanilla
 * - PUNTO 7:  cada modpack usa su propia carpeta de mods
 * - PUNTO 9:  usa http.js unificado (fetchJSON, download, friendlyError)
 * - PUNTO 12: directorio base separado del .minecraft oficial
 * - PUNTO 13: errores de red diferenciados
 * - FIX 2:    mods descargados en parallel() en vez de for-loop síncrono
 * - FIX 4:    hash SHA1 de mods usando streams (no readFileSync)
 * - FIX 5:    options.txt copiado desde .minecraft oficial de Mojang
 *
 * SECURITY FIXES:
 * - SEC 2: path traversal en mod.name — cada ruta de mod se valida
 *   contra modsDir antes de escribir. Si el servidor de modpacks es
 *   comprometido, no puede escribir archivos fuera de la carpeta de mods.
 * - SEC 3: hash SHA1 verificado TAMBIÉN post-descarga, no solo para
 *   saltarse la descarga. Archivos con hash inválido son eliminados y
 *   se reportan como error. Previene uso de mods manipulados en tránsito.
 * - SEC 2b: mod.url validada — solo se descargan URLs https:// de hosts
 *   conocidos. Previene SSRF o descarga de contenido arbitrario.
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const os     = require('os')

const config            = require('../utils/config')
const installer         = require('./installer')
const { installLoader } = require('./loaderInstaller')
const { fetchJSON, download, friendlyError } = require('../utils/http')

const MODPACKS_URL     = 'https://humitaclient.sytes.net/modpacks.json'
const CONCURRENCY_MODS = 4

// SEC 2b: lista de hosts permitidos para descarga de mods.
// Ampliar según los CDNs que uses (e.g. modrinth, curseforge, tu propio servidor).
const ALLOWED_MOD_HOSTS = new Set([
  'humitaclient.sytes.net',
  'cdn.modrinth.com',
  'media.forgecdn.net',
  'edge.forgecdn.net',
])

const FALLBACK_MODPACKS = {
  modpacks: [],
}

// ─── Directorios de instancia ─────────────────────────────────

function getBaseDir() {
  const base = os.platform() === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : os.homedir()
  return path.join(base, '.humita')
}

function getModpackDir(modpackId) {
  return path.join(getBaseDir(), 'instances', modpackId)
}

function getModsDir(modpackId) {
  return path.join(getModpackDir(modpackId), 'mods')
}

// ─── Directorio .minecraft oficial de Mojang ──────────────────

function getVanillaMinecraftDir() {
  switch (os.platform()) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft')
    default:
      return path.join(os.homedir(), '.minecraft')
  }
}

// ─── options.txt global ───────────────────────────────────────
//
// Jerarquía de fuentes (se usa la primera que exista):
//   1. ~/.humita/options.txt        — global del launcher (fuente de verdad)
//   2. ~/.minecraft/options.txt     — Mojang oficial (fallback automático)
//   3. Sin copiar                   — Minecraft usa sus defaults

function getGlobalOptionsPath() {
  return path.join(getBaseDir(), 'options.txt')
}

function resolveOptionsSource() {
  const globalOptions = getGlobalOptionsPath()
  if (fs.existsSync(globalOptions)) {
    console.log('[modpacks] Usando options.txt global del launcher')
    return globalOptions
  }
  const vanillaOptions = path.join(getVanillaMinecraftDir(), 'options.txt')
  if (fs.existsSync(vanillaOptions)) {
    console.log('[modpacks] Usando options.txt del .minecraft oficial (fallback)')
    return vanillaOptions
  }
  console.warn('[modpacks] No hay options.txt disponible — Minecraft usará defaults')
  return null
}

function applyOptionsToInstance(instanceDir) {
  const source = resolveOptionsSource()
  if (!source) return { copied: false, source: null }
  try {
    const dest = path.join(instanceDir, 'options.txt')
    fs.copyFileSync(source, dest)
    return { copied: true, source }
  } catch (e) {
    console.warn('[modpacks] Error copiando options.txt:', e.message)
    return { copied: false, source }
  }
}

function saveGlobalOptions(srcPath) {
  const globalPath = getGlobalOptionsPath()
  try {
    if (typeof srcPath === 'string' && !srcPath.includes('\n') && fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, globalPath)
    } else {
      fs.writeFileSync(globalPath, srcPath, 'utf-8')
    }
    return { success: true, path: globalPath }
  } catch (e) {
    return { success: false, message: e.message }
  }
}

function importOptionsFromInstance(modpackId) {
  const instanceDir  = getModpackDir(modpackId)
  const instanceOpts = path.join(instanceDir, 'options.txt')
  if (!fs.existsSync(instanceOpts)) {
    return { success: false, message: 'La instancia "' + modpackId + '" no tiene options.txt' }
  }
  return saveGlobalOptions(instanceOpts)
}

function getGlobalOptionsInfo() {
  const globalPath = getGlobalOptionsPath()
  const exists     = fs.existsSync(globalPath)
  return {
    exists,
    path:     globalPath,
    modified: exists ? fs.statSync(globalPath).mtime.toISOString() : null,
  }
}

// ─── SHA1 por stream ──────────────────────────────────────────

function sha1FileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data',  chunk => hash.update(chunk))
    stream.on('end',   ()    => resolve(hash.digest('hex')))
    stream.on('error', err   => reject(err))
  })
}

async function modFileOk(filePath, expectedSha1) {
  if (!fs.existsSync(filePath)) return false
  if (!expectedSha1)            return true
  try {
    return (await sha1FileStream(filePath)) === expectedSha1
  } catch {
    return false
  }
}

// ─── SEC 2: Validación de path traversal ─────────────────────
// Verifica que destPath esté estrictamente dentro de baseDir.
// Usa path.resolve para normalizar antes de comparar, de forma que
// "../../../etc/passwd" u otras secuencias sean neutralizadas.

function isPathSafe(baseDir, destPath) {
  const resolvedBase = path.resolve(baseDir)
  const resolvedDest = path.resolve(destPath)
  // El separador al final de resolvedBase garantiza que un directorio
  // "baseDir_evil" no sea aceptado como prefijo válido de "baseDir".
  return resolvedDest.startsWith(resolvedBase + path.sep) ||
         resolvedDest === resolvedBase
}

// ─── SEC 2b: Validación de URL de mod ────────────────────────
// Solo permite URLs https:// de hosts en ALLOWED_MOD_HOSTS.

function isModUrlAllowed(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_MOD_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

// ─── parallel ─────────────────────────────────────────────────

async function parallel(tasks, concurrency) {
  let index = 0
  async function worker() {
    while (index < tasks.length) {
      const i = index++
      await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
}

// ─── API pública ──────────────────────────────────────────────

async function fetchModpacks() {
  try {
    const data = await fetchJSON(MODPACKS_URL)
    if (!data.modpacks || !Array.isArray(data.modpacks)) {
      throw new Error('Formato inválido')
    }

    const remoteIds = new Set(data.modpacks.map(mp => mp.id))

    const withStatus = data.modpacks.map(mp => ({
      ...mp,
      installed:   isInstalled(mp.id),
      instanceDir: getModpackDir(mp.id),
    }))

    // Agregar instancias instaladas localmente que ya no están en el servidor
    // (por ejemplo, modpacks recién añadidos al launcher antes de que el
    // servidor los publique, o packs eliminados remotamente pero conservados
    // localmente).
    const localInstalled = config.get('installedModpacks') || {}
    for (const [id, info] of Object.entries(localInstalled)) {
      if (remoteIds.has(id)) continue   // ya viene del servidor, no duplicar
      withStatus.push({
        id,
        name:        info.name        || id,
        version:     info.version     || '?',
        description: info.description || '',
        serverIp:    info.serverIp    || '',
        loader:      info.loaderType
          ? { type: info.loaderType, version: info.loaderVersion }
          : null,
        mods:        [],
        installed:   true,
        instanceDir: getModpackDir(id),
        _localOnly:  true,   // flag informativo para la UI si lo necesita
      })
    }

    return { success: true, modpacks: withStatus }

  } catch (err) {
    const isNetwork = err.name === 'NetworkError' || err.name === 'HttpError'
    const reason    = isNetwork
      ? `Sin conexión al servidor de modpacks (${friendlyError(err)})`
      : err.message

    console.warn('[modpacks] Usando fallback. Motivo:', reason)

    const fallbackIds = new Set(FALLBACK_MODPACKS.modpacks.map(mp => mp.id))

    const withStatus = FALLBACK_MODPACKS.modpacks.map(mp => ({
      ...mp,
      installed:   isInstalled(mp.id),
      instanceDir: getModpackDir(mp.id),
    }))

    // En modo offline también mostrar las instancias instaladas localmente
    const localInstalled = config.get('installedModpacks') || {}
    for (const [id, info] of Object.entries(localInstalled)) {
      if (fallbackIds.has(id)) continue
      withStatus.push({
        id,
        name:        info.name        || id,
        version:     info.version     || '?',
        description: info.description || '',
        serverIp:    info.serverIp    || '',
        loader:      info.loaderType
          ? { type: info.loaderType, version: info.loaderVersion }
          : null,
        mods:        [],
        installed:   true,
        instanceDir: getModpackDir(id),
        _localOnly:  true,
      })
    }

    return {
      success:       true,
      modpacks:      withStatus,
      offline:       true,
      offlineReason: reason,
    }
  }
}

async function installModpack(modpackId, modpackData, onProgress) {
  try {
    const instanceDir = getModpackDir(modpackId)
    const modsDir     = getModsDir(modpackId)
    fs.mkdirSync(instanceDir, { recursive: true })
    fs.mkdirSync(modsDir,     { recursive: true })

    const hasLoader = !!(modpackData.loader?.type && modpackData.loader?.version)

    // ── PASO 1: Instalar Minecraft vanilla base ────────────────
    onProgress({ message: `Instalando Minecraft ${modpackData.version}...`, percent: 5 })

    const installRes = await installer.install(modpackData.version, (p) => {
      const scale = hasLoader ? 0.50 : 0.65
      onProgress({ message: p.message, percent: 5 + Math.floor(p.percent * scale) })
    })

    if (!installRes.success) return installRes

    // ── PASO 2: Instalar loader (Fabric o Forge) si corresponde ─
    let launchVersionId = modpackData.version

    if (hasLoader) {
      onProgress({
        message: `Instalando ${modpackData.loader.type} ${modpackData.loader.version}...`,
        percent: 57,
      })

      const loaderRes = await installLoader(
        modpackData.loader,
        modpackData.version,
        (p) => onProgress({ message: p.message, percent: 57 + Math.floor((p.percent / 100) * 13) }),
        0,
      )

      if (!loaderRes.success) return loaderRes

      launchVersionId = loaderRes.versionId
      onProgress({ message: `${modpackData.loader.type} ${modpackData.loader.version} listo ✓`, percent: 70 })
    }

    // ── PASO 3: Descargar mods ─────────────────────────────────
    const mods = modpackData.mods || []

    if (mods.length > 0) {
      onProgress({ message: `Verificando ${mods.length} mods...`, percent: 70 })

      let modsDone    = 0
      let modsSkipped = 0
      const modErrors = []

      await parallel(mods.map((mod) => async () => {
        modsDone++

        // SEC 2: construir la ruta destino y validarla contra modsDir
        // ANTES de cualquier operación de disco.
        const rawModPath = path.join(modsDir, mod.name + '.jar')

        if (!isPathSafe(modsDir, rawModPath)) {
          const msg = `Path traversal bloqueado en mod "${mod.name}"`
          console.error(`[modpacks] SEC: ${msg}`)
          modErrors.push({ name: mod.name, error: msg })
          return
        }

        const modPath = rawModPath

        // SEC 2b: validar URL del mod antes de descargar
        if (!isModUrlAllowed(mod.url)) {
          const msg = `URL de mod no permitida: "${mod.url}"`
          console.error(`[modpacks] SEC: ${msg}`)
          modErrors.push({ name: mod.name, error: msg })
          return
        }

        // Verificar si el archivo ya existe y tiene hash correcto
        if (await modFileOk(modPath, mod.sha1)) {
          modsSkipped++
          onProgress({
            message: `Mod ${modsDone}/${mods.length}: ${mod.name} (ya existe ✓)`,
            percent: 70 + Math.floor((modsDone / mods.length) * 25),
          })
          return
        }

        // Descargar el mod
        try {
          await download(mod.url, modPath)
        } catch (err) {
          const friendly = friendlyError(err)
          modErrors.push({ name: mod.name, error: friendly })
          console.warn(`[modpacks] Fallo descargando ${mod.name}: ${friendly}`)
          // Si el archivo quedó a medias, eliminarlo
          try { if (fs.existsSync(modPath)) fs.unlinkSync(modPath) } catch { /* ignorar */ }
          onProgress({
            message: `Mod ${modsDone}/${mods.length}: ${mod.name} ✗`,
            percent: 70 + Math.floor((modsDone / mods.length) * 25),
          })
          return
        }

        // SEC 3: verificar hash SHA1 DESPUÉS de la descarga.
        // Si no coincide, el archivo se elimina y se reporta el error.
        // Esto detecta tanto corrupción de red como manipulación en tránsito.
        if (mod.sha1) {
          const downloadedHashOk = await modFileOk(modPath, mod.sha1)
          if (!downloadedHashOk) {
            const msg = `Hash SHA1 inválido post-descarga`
            console.error(`[modpacks] SEC: ${mod.name} — ${msg}. Esperado: ${mod.sha1}`)
            modErrors.push({ name: mod.name, error: msg })
            try { fs.unlinkSync(modPath) } catch { /* ignorar */ }
            onProgress({
              message: `Mod ${modsDone}/${mods.length}: ${mod.name} ✗ (hash inválido)`,
              percent: 70 + Math.floor((modsDone / mods.length) * 25),
            })
            return
          }
        }

        onProgress({
          message: `Mod ${modsDone}/${mods.length}: ${mod.name} ✓`,
          percent: 70 + Math.floor((modsDone / mods.length) * 25),
        })
      }), CONCURRENCY_MODS)

      if (modErrors.length > 0) {
        console.warn('[modpacks] Mods con errores:', modErrors)
        const okCount = mods.length - modErrors.length
        onProgress({
          message: `⚠ ${modErrors.length} mod(s) no se descargaron. ${okCount} ok, ${modsSkipped} ya existían.`,
          percent: 95,
        })
      } else {
        const downloaded = mods.length - modsSkipped
        const parts = []
        if (downloaded > 0) parts.push(`${downloaded} descargado(s)`)
        if (modsSkipped  > 0) parts.push(`${modsSkipped} ya existían`)
        onProgress({
          message: `Mods listos ✓  (${parts.join(', ')})`,
          percent: 95,
        })
      }
    }

    // ── PASO 4: Aplicar options.txt global ───────────────────
    // Usa la jerarquía: global del launcher → .minecraft oficial → sin copiar
    const optResult = applyOptionsToInstance(instanceDir)
    if (optResult.copied) {
      const srcLabel = optResult.source === getGlobalOptionsPath()
        ? 'configuración global ✓'
        : 'configuración de .minecraft oficial ✓'
      onProgress({ message: `Opciones aplicadas desde ${srcLabel}`, percent: 98 })
    }

    // ── PASO 5: Guardar estado ─────────────────────────────────
    config.set('lastServerIp', modpackData.serverIp)
    markInstalled(modpackId, modpackData, launchVersionId)

    onProgress({ message: `¡${modpackData.name} instalado!`, percent: 100 })

    return {
      success:        true,
      message:        `${modpackData.name} instalado correctamente.`,
      instanceDir,
      launchVersionId,
    }

  } catch (err) {
    return { success: false, message: friendlyError(err) }
  }
}

// ─── Estado de instalación ────────────────────────────────────

function isInstalled(modpackId) {
  const installed = config.get('installedModpacks') || {}
  return Boolean(installed[modpackId])
}

function markInstalled(modpackId, modpackData, launchVersionId) {
  const installed = config.get('installedModpacks') || {}
  installed[modpackId] = {
    name:            modpackData.name        || modpackId,
    description:     modpackData.description || '',
    version:         modpackData.version,
    loaderType:      modpackData.loader?.type    || null,
    loaderVersion:   modpackData.loader?.version || null,
    launchVersionId,
    serverIp:        modpackData.serverIp,
    instanceDir:     getModpackDir(modpackId),
    installedAt:     new Date().toISOString(),
  }
  config.set('installedModpacks', installed)
}

function getInstalledInfo(modpackId) {
  const installed = config.get('installedModpacks') || {}
  return installed[modpackId] || null
}

module.exports = {
  fetchModpacks,
  installModpack,
  isInstalled,
  getInstalledInfo,
  getModpackDir,
  // options.txt global
  getGlobalOptionsPath,
  getGlobalOptionsInfo,
  saveGlobalOptions,
  importOptionsFromInstance,
  applyOptionsToInstance,
}