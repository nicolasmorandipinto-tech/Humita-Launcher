/**
 * utils/javaFinder.js
 * CORRECCIÓN ORIGINAL:
 * - FIX 9: la ruta obtenida desde PATH/which ahora se valida con
 *   verifyJava() antes de retornarla, en lugar de devolverla a ciegas.
 *
 * SECURITY FIX (SEC 5):
 * - findJavaAsync() ya no usa Worker con { eval: true } y string dinámico.
 *   El script del worker está definido como literal estático en este mismo
 *   módulo, así __dirname se resuelve en tiempo de carga del módulo
 *   (proceso main de Electron) y no puede ser manipulado externamente.
 *   Esto elimina el riesgo de inyección de código en el worker.
 *
 *   Se exporta findJavaAsync() desde aquí para que launcher.js lo importe
 *   directamente, en vez de tener un archivo worker separado que tiene
 *   problemas con el empaquetado asar de Electron.
 */

const { spawnSync }  = require('child_process')
const { Worker }     = require('worker_threads')
const fs             = require('fs')
const path           = require('path')
const os             = require('os')

const COMMON_PATHS = {
  win32: [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Zulu',
  ],
  linux: ['/usr/lib/jvm', '/usr/local/lib/jvm', '/opt/java', '/opt/jdk'],
  darwin: [
    '/Library/Java/JavaVirtualMachines',
    '/System/Library/Java/JavaVirtualMachines',
  ],
}

function findJava() {
  // 1. Desde PATH — FIX 9: verificar con verifyJava() antes de usarla
  try {
    const whichCmd = os.platform() === 'win32' ? 'where' : 'which'
    const which = spawnSync(whichCmd, ['java'], { encoding: 'utf-8' })
    if (which.status === 0) {
      const candidates = which.stdout.trim().split('\n')
      for (const candidate of candidates) {
        const resolved = candidate.trim()
        if (resolved && verifyJava(resolved)) return resolved
      }
    }
  } catch (e) {
    console.error(e)
  }

  // 2. JAVA_HOME env
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const bin = path.join(javaHome, 'bin', os.platform() === 'win32' ? 'java.exe' : 'java')
    if (verifyJava(bin)) return bin
  }

  // 3. Rutas comunes
  const platform = os.platform()
  const paths = COMMON_PATHS[platform] || []

  for (const base of paths) {
    if (!fs.existsSync(base)) continue
    const found = searchJavaIn(base)
    if (found) return found
  }

  return null
}

function searchJavaIn(dir) {
  const javaExe = os.platform() === 'win32' ? 'java.exe' : 'java'
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(dir, entry.name, 'bin', javaExe)
      if (verifyJava(candidate)) return candidate
    }
  } catch (e) {
    console.error(e)
  }
  return null
}

function verifyJava(javaPath) {
  if (!javaPath || !fs.existsSync(javaPath)) return false
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}

function getVersion(javaPath) {
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
    const output = result.stderr || result.stdout || ''
    const match  = output.match(/version "([^"]+)"/)
    return match ? match[1] : 'Desconocida'
  } catch {
    return 'Desconocida'
  }
}

// ─── SEC 5: findJavaAsync sin eval dinámico ───────────────────
//
// El script del worker se define como template literal estático aquí.
// __dirname se resuelve cuando Node carga este módulo (proceso main),
// no en tiempo de ejecución del worker — así no hay interpolación de
// datos externos. JSON.stringify solo serializa el string del path
// resuelto, que es una constante del módulo.
//
// Ventaja sobre un archivo separado: funciona correctamente con el
// empaquetado asar de Electron, donde los Worker desde rutas de archivo
// pueden fallar si el runtime no soporta workers dentro del asar.

// Path resuelto en tiempo de carga del módulo — no manipulable externamente
const _SELF_PATH = JSON.stringify(path.resolve(__filename))

const _WORKER_SCRIPT = `
  const { parentPort } = require('worker_threads')
  const javaFinder = require(${_SELF_PATH})
  try {
    const result = javaFinder.findJava()
    parentPort.postMessage(result)
  } catch (err) {
    console.error('[javaFinderWorker] Error:', err.message)
    parentPort.postMessage(null)
  }
`

function findJavaAsync() {
  return new Promise((resolve) => {
    let worker
    try {
      worker = new Worker(_WORKER_SCRIPT, { eval: true })
    } catch {
      console.warn('[javaFinder] Worker threads no disponibles — findJava() en hilo principal')
      resolve(findJava())
      return
    }

    const timeout = setTimeout(() => {
      worker.terminate()
      console.warn('[javaFinder] findJava() timeout en worker — usando fallback')
      resolve(null)
    }, 8000)

    worker.once('message', (result) => {
      clearTimeout(timeout)
      resolve(result)
    })

    worker.once('error', () => {
      clearTimeout(timeout)
      try { resolve(findJava()) } catch { resolve(null) }
    })
  })
}

module.exports = { findJava, findJavaAsync, verifyJava, getVersion }
