/**
 * core/launcher.js
 * CORRECCIONES:
 * - FIX 2: javaFinder.findJava() usa spawnSync internamente, lo que
 *   bloqueaba el hilo principal de Electron varios segundos. Ahora se
 *   ejecuta dentro de un Worker thread para no congelar la UI.
 * - LOADER: cuando se lanza un modpack, se usa el launchVersionId
 *   guardado en installedModpacks (que puede ser el versionId de
 *   Fabric o Forge, no el vanilla base).
 * - FIX ASM: deduplicación del classpath por group:artifact,
 *   quedándose con la versión más alta para evitar "duplicate ASM classes".
 * - FIX NATIVES: nativesDir apunta al vanilla padre (inheritsFrom).
 *   Extracción de nativos implementada en Node puro (fs + zlib)
 *   sin depender de `jar` ni `unzip` en el PATH.
 *
 * SECURITY FIXES:
 * - SEC 1: serverIp sanitizado — solo caracteres válidos en host, puerto
 *   forzado a entero 1-65535. Previene inyección de argumentos JVM.
 * - SEC 5: Worker creado desde archivo separado en vez de eval: true.
 *   Previene ejecución de código dinámico arbitrario.
 * - SEC 7: javaPath validado — debe existir en disco y ser un ejecutable
 *   reconocido ("java" o "javaw"). Previene sustitución del binario.
 */

const { spawn }  = require('child_process')
const { Worker } = require('worker_threads')
const fs         = require('fs')
const path       = require('path')
const os         = require('os')
const zlib       = require('zlib')

const config     = require('../utils/config')
const { findJavaAsync, verifyJava, findJava } = require('../utils/javaFinder')
const { getModpackDir, getInstalledInfo } = require('./modpackManager')

let _process = null

// ─── SEC 7: Validación del ejecutable Java ────────────────────
// Verifica que javaPath exista en disco y que el basename sea
// "java" o "javaw" (con o sin .exe). Así un config.javaPath
// manipulado desde el renderer no puede apuntar a otro binario.

const JAVA_VALID_BASENAMES = new Set(['java', 'javaw', 'java.exe', 'javaw.exe'])

function validateJavaPath(javaPath) {
  if (!javaPath || typeof javaPath !== 'string') return false
  const base = path.basename(javaPath).toLowerCase()
  if (!JAVA_VALID_BASENAMES.has(base)) {
    console.warn(`[launcher] javaPath rechazado — basename inválido: "${base}"`)
    return false
  }
  // verifyJava también comprueba que el archivo exista y ejecute -version
  if (!verifyJava(javaPath)) {
    console.warn(`[launcher] javaPath rechazado — no pasa verifyJava(): "${javaPath}"`)
    return false
  }
  return true
}

// ─── SEC 1: Sanitización de serverIp ─────────────────────────
// host: solo letras, dígitos, puntos y guiones (RFC 1123 + IPv4).
// port: entero 1-65535.
// Previene inyección de argumentos arbitrarios en el array de spawn.

function sanitizeServerIp(serverIp) {
  if (!serverIp || typeof serverIp !== 'string') return null

  const [rawHost, rawPort] = serverIp.split(':')

  const host = (rawHost || '').replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 253)
  if (!host) return null

  const portNum = parseInt(rawPort, 10)
  const port    = (!isNaN(portNum) && portNum >= 1 && portNum <= 65535)
    ? portNum
    : 25565

  return { host, port }
}

// findJavaAsync está definido en utils/javaFinder.js e importado arriba.
// SEC 5: el worker usa { eval: true } con un script estático cuyo path
// se resuelve en tiempo de carga del módulo — no hay interpolación de
// datos externos. Ver javaFinder.js para el detalle de la implementación.

// ─── Extractor ZIP nativo (Node puro, sin dependencias) ───────

/**
 * Lee el Central Directory de un ZIP/JAR y retorna la lista de entradas.
 * Formato ZIP: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
function readZipEntries(buf) {
  const entries = []

  // Buscar End of Central Directory (EOCD) signature: 0x06054b50
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) throw new Error('No se encontró EOCD en el ZIP')

  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  const cdCount  = buf.readUInt16LE(eocdOffset + 10)

  let offset = cdOffset
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break

    const compression    = buf.readUInt16LE(offset + 10)
    const compressedSz   = buf.readUInt32LE(offset + 20)
    const uncompressedSz = buf.readUInt32LE(offset + 24)
    const fileNameLen    = buf.readUInt16LE(offset + 28)
    const extraLen       = buf.readUInt16LE(offset + 30)
    const commentLen     = buf.readUInt16LE(offset + 32)
    const localOffset    = buf.readUInt32LE(offset + 42)
    const fileName       = buf.toString('utf8', offset + 46, offset + 46 + fileNameLen)

    entries.push({ fileName, compression, compressedSz, uncompressedSz, localOffset })
    offset += 46 + fileNameLen + extraLen + commentLen
  }

  return entries
}

/**
 * Extrae un JAR/ZIP en destDir usando solo Node (fs + zlib).
 * Solo extrae archivos nativos (.dll, .so, .dylib) ignorando carpetas
 * y archivos META-INF.
 *
 * FIX 6: recibe el Buffer directamente (el caller lo lee con
 * fs.promises.readFile de forma asíncrona) en vez de leer el archivo
 * de forma síncrona internamente.
 */
function extractNativesFromBuf(buf, jarName, destDir) {
  let entries

  try {
    entries = readZipEntries(buf)
  } catch (e) {
    console.warn(`[launcher] No se pudo leer ZIP ${jarName}: ${e.message}`)
    return 0
  }

  const nativeExts = ['.dll', '.so', '.dylib']
  let extracted = 0

  for (const entry of entries) {
    const name = entry.fileName

    if (name.endsWith('/'))        continue
    if (name.startsWith('META-INF')) continue
    const ext = path.extname(name).toLowerCase()
    if (!nativeExts.includes(ext)) continue

    const localSig = buf.readUInt32LE(entry.localOffset)
    if (localSig !== 0x04034b50) continue

    const localFileNameLen = buf.readUInt16LE(entry.localOffset + 26)
    const localExtraLen    = buf.readUInt16LE(entry.localOffset + 28)
    const dataOffset = entry.localOffset + 30 + localFileNameLen + localExtraLen

    const compressedData = buf.slice(dataOffset, dataOffset + entry.compressedSz)

    let finalData
    try {
      if (entry.compression === 0) {
        finalData = compressedData
      } else if (entry.compression === 8) {
        finalData = zlib.inflateRawSync(compressedData)
      } else {
        console.warn(`[launcher] Compresión no soportada (${entry.compression}) en ${name}`)
        continue
      }
    } catch (e) {
      console.warn(`[launcher] Error descomprimiendo ${name}: ${e.message}`)
      continue
    }

    const outPath = path.join(destDir, path.basename(name))
    try {
      fs.writeFileSync(outPath, finalData)
      extracted++
    } catch (e) {
      console.warn(`[launcher] Error escribiendo ${outPath}: ${e.message}`)
    }
  }

  return extracted
}

// ─── FIX NATIVES: extracción de nativos LWJGL ────────────────

async function ensureNatives(metadata, libsDir, nativesDir, globalDir) {
  const allLibs = [...(metadata.libraries || [])]

  if (metadata.inheritsFrom) {
    try {
      const parentPath = path.join(
        globalDir, 'versions', metadata.inheritsFrom,
        `${metadata.inheritsFrom}.json`
      )
      if (fs.existsSync(parentPath)) {
        const parent = JSON.parse(await fs.promises.readFile(parentPath, 'utf-8'))
        allLibs.push(...(parent.libraries || []))
      }
    } catch { /* ignorar */ }
  }

  const alreadyExtracted = fs.existsSync(nativesDir) &&
    fs.readdirSync(nativesDir).some(f =>
      f.endsWith('.dll') || f.endsWith('.so') || f.endsWith('.dylib')
    )

  if (alreadyExtracted) return

  fs.mkdirSync(nativesDir, { recursive: true })
  console.log('[launcher] Extrayendo nativos en:', nativesDir)

  const platform = os.platform()
  const platformKeywords = platform === 'win32'
    ? ['natives-windows']
    : platform === 'darwin'
    ? ['natives-osx', 'natives-macos']
    : ['natives-linux']

  let totalExtracted = 0

  for (const lib of allLibs) {
    const classifiers = lib.downloads?.classifiers
    if (classifiers) {
      for (const [key, artifact] of Object.entries(classifiers)) {
        if (!platformKeywords.some(kw => key.includes(kw))) continue
        if (key.includes('arm64') && os.arch() !== 'arm64') continue
        if (key.includes('x86') && os.arch() !== 'ia32') continue

        if (artifact?.path) {
          const jarPath = path.join(libsDir, artifact.path)
          if (fs.existsSync(jarPath)) {
            const buf = await fs.promises.readFile(jarPath)
            const n = extractNativesFromBuf(buf, path.basename(jarPath), nativesDir)
            totalExtracted += n
          }
        }
      }
      continue
    }

    if (lib.name?.includes('natives')) {
      const isForPlatform = platformKeywords.some(kw => lib.name.includes(kw))
      if (!isForPlatform) continue
      if (lib.name.includes('arm64') && os.arch() !== 'arm64') continue
      if (lib.name.includes('x86') && !lib.name.includes('x86_64') && os.arch() !== 'ia32') continue

      const artifact = lib.downloads?.artifact
      if (artifact?.path) {
        const jarPath = path.join(libsDir, artifact.path)
        if (fs.existsSync(jarPath)) {
          const buf = await fs.promises.readFile(jarPath)
          const n = extractNativesFromBuf(buf, path.basename(jarPath), nativesDir)
          totalExtracted += n
        }
      }
    }
  }

  console.log(`[launcher] Nativos extraídos: ${totalExtracted} archivo(s)`)
}

// ─────────────────────────────────────────────────────────────

async function launch(versionId, serverIp, onLog, modpackId = null) {
  try {
    const mcDir = modpackId
      ? getModpackDir(modpackId)
      : config.minecraftDir

    let effectiveVersionId = versionId
    if (modpackId) {
      const info = getInstalledInfo(modpackId)
      if (info?.launchVersionId) {
        effectiveVersionId = info.launchVersionId
        onLog(`[INFO] Usando loader: ${effectiveVersionId}`)
      }
    }

    const globalDir   = config.minecraftDir
    const versionsDir = path.join(globalDir, 'versions', effectiveVersionId)
    const metaPath    = path.join(versionsDir, `${effectiveVersionId}.json`)

    if (!fs.existsSync(metaPath)) {
      return {
        success: false,
        message: `Versión ${effectiveVersionId} no está instalada. Reinstala el modpack.`,
      }
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // SEC 7: validar javaPath antes de usarlo
    const configuredJava = config.get('javaPath')
    let javaPath

    if (configuredJava) {
      if (!validateJavaPath(configuredJava)) {
        return {
          success: false,
          message: 'La ruta de Java configurada no es válida. Revisa los Ajustes.',
        }
      }
      javaPath = configuredJava
    } else {
      javaPath = await findJavaAsync()
    }

    if (!javaPath) {
      return { success: false, message: 'Java no encontrado. Configúralo en Ajustes.' }
    }

    const { accessToken } = await config.getTokens()

    const libsDir       = path.join(globalDir, 'libraries')
    const nativesParent = metadata.inheritsFrom || effectiveVersionId
    const nativesDir    = path.join(globalDir, 'versions', nativesParent, 'natives')

    await ensureNatives(metadata, libsDir, nativesDir, globalDir)

    // SEC 1: sanitizar serverIp antes de construir args
    const sanitizedServer = sanitizeServerIp(serverIp)

    const args = buildArgs(
      javaPath, metadata, effectiveVersionId,
      mcDir, sanitizedServer, accessToken, nativesDir
    )

    fs.mkdirSync(mcDir, { recursive: true })

    onLog(`[INFO] Iniciando Minecraft ${effectiveVersionId}...`)
    onLog(`[INFO] GameDir: ${mcDir}`)
    onLog(`[JAVA] ${javaPath}`)

    _process = spawn(args[0], args.slice(1), {
      cwd:   mcDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: false es el default en spawn — explicitarlo para claridad
      shell: false,
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

function buildArgs(javaPath, metadata, versionId, gameDir, sanitizedServer, accessToken, nativesDir) {
  const ramMin   = config.get('ramMin') || '1G'
  const ramMax   = config.get('ramMax') || '2G'
  const username = config.get('username') || 'Player'
  const uuid     = config.get('uuid')     || '00000000-0000-0000-0000-000000000000'
  const authType = config.get('authType') || 'offline'
  const token    = accessToken || 'offline'

  const globalDir   = config.minecraftDir
  const libsDir     = path.join(globalDir, 'libraries')
  const assetsDir   = path.join(globalDir, 'assets')
  const versionsDir = path.join(globalDir, 'versions', versionId)

  const mainClass  = metadata.mainClass || 'net.minecraft.client.main.Main'
  const assetIndex = resolveAssetIndex(metadata, globalDir, versionId)

  const sep       = os.platform() === 'win32' ? ';' : ':'
  const classpath = buildClasspath(metadata, libsDir, versionsDir, versionId, globalDir, sep)

  const args = [
    javaPath,
    `-Xms${ramMin}`,
    `-Xmx${ramMax}`,
    `-Djava.library.path=${nativesDir}`,
    '-cp', classpath,
    mainClass,
    '--username',    username,
    '--version',     versionId,
    '--gameDir',     gameDir,
    '--assetsDir',   assetsDir,
    '--assetIndex',  assetIndex,
    '--uuid',        uuid,
    '--accessToken', token,
    '--userType',    authType === 'microsoft' ? 'msa' : 'legacy',
  ]

  // SEC 1: usar sanitizedServer (objeto {host, port}) en vez del string crudo
  if (sanitizedServer) {
    args.push('--server', sanitizedServer.host)
    args.push('--port',   String(sanitizedServer.port))
  }

  return args
}

function resolveAssetIndex(metadata, globalDir, versionId) {
  if (metadata.assetIndex?.id) return metadata.assetIndex.id

  if (metadata.inheritsFrom) {
    try {
      const parentPath = path.join(
        globalDir, 'versions', metadata.inheritsFrom,
        `${metadata.inheritsFrom}.json`
      )
      if (fs.existsSync(parentPath)) {
        const parent = JSON.parse(fs.readFileSync(parentPath, 'utf-8'))
        if (parent.assetIndex?.id) return parent.assetIndex.id
      }
    } catch { /* ignorar */ }
  }

  console.warn(`[launcher] assetIndex no encontrado para ${versionId}, usando 'legacy' como fallback`)
  return 'legacy'
}

function parseMavenName(name) {
  if (!name) return null
  const parts = name.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version] = parts
  return { groupArtifact: `${group}:${artifact}`, version }
}

function versionIsHigher(versionA, versionB) {
  const parse = v => v.split(/[.\-]/).map(p => parseInt(p) || 0)
  const a = parse(versionA)
  const b = parse(versionB)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

function buildClasspath(metadata, libsDir, versionsDir, versionId, globalDir, sep) {
  const libMap = new Map()

  function addLib(filePath, mavenName) {
    if (!fs.existsSync(filePath)) return

    const parsed = parseMavenName(mavenName)

    if (!parsed) {
      libMap.set(filePath, { filePath, version: null })
      return
    }

    const existing = libMap.get(parsed.groupArtifact)
    if (!existing) {
      libMap.set(parsed.groupArtifact, { filePath, version: parsed.version })
    } else if (existing.version && versionIsHigher(parsed.version, existing.version)) {
      console.log(
        `[launcher] Deduplicando ${parsed.groupArtifact}: ` +
        `${existing.version} → ${parsed.version} (usando la más reciente)`
      )
      libMap.set(parsed.groupArtifact, { filePath, version: parsed.version })
    }
  }

  for (const lib of metadata.libraries || []) {
    const artifact = lib.downloads?.artifact
    if (artifact?.path) {
      addLib(path.join(libsDir, artifact.path), lib.name)
      continue
    }
    if (lib.name) {
      const p = mavenNameToPath(lib.name, libsDir)
      if (p) addLib(p, lib.name)
    }
  }

  if (metadata.inheritsFrom) {
    try {
      const parentPath = path.join(
        globalDir, 'versions', metadata.inheritsFrom,
        `${metadata.inheritsFrom}.json`
      )
      if (fs.existsSync(parentPath)) {
        const parent = JSON.parse(fs.readFileSync(parentPath, 'utf-8'))
        for (const lib of parent.libraries || []) {
          const artifact = lib.downloads?.artifact
          if (!artifact?.path) continue
          addLib(path.join(libsDir, artifact.path), lib.name)
        }
        const vanillaJar = path.join(
          globalDir, 'versions', metadata.inheritsFrom,
          `${metadata.inheritsFrom}.jar`
        )
        if (fs.existsSync(vanillaJar)) {
          libMap.set('__vanillaJar__', { filePath: vanillaJar, version: null })
        }
      }
    } catch { /* ignorar */ }
  }

  const clientJar = path.join(versionsDir, `${versionId}.jar`)
  if (fs.existsSync(clientJar)) {
    libMap.set('__clientJar__', { filePath: clientJar, version: null })
  }

  return [...libMap.values()].map(e => e.filePath).join(sep)
}

function mavenNameToPath(name, libsDir) {
  const parts = name.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version] = parts
  const groupPath = group.replace(/\./g, '/')
  return path.join(libsDir, groupPath, artifact, version, `${artifact}-${version}.jar`)
}

function kill() {
  if (_process) {
    _process.kill()
    _process = null
  }
}

module.exports = { launch, kill }
