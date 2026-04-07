const https  = require('https')
const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const config         = require('../utils/config')
const versionManager = require('./versionManager')

const CONCURRENCY_LIBS   = 16
const CONCURRENCY_ASSETS = 32

// ─── Utilidades ───────────────────────────────────────────────

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const tmp   = dest + '.tmp'
    const file  = fs.createWriteStream(tmp)

    const req = proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy()
        fs.unlink(tmp, () => {})
        return download(res.headers.location, dest, onProgress).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.destroy()
        fs.unlink(tmp, () => {})
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      const total  = parseInt(res.headers['content-length'] || '0')
      let received = 0

      res.on('data', chunk => {
        file.write(chunk)
        received += chunk.length
        if (onProgress && total) onProgress(Math.floor(received / total * 100))
      })

      res.on('end', () => {
        file.end(() => {
          fs.rename(tmp, dest, err => err ? reject(err) : resolve())
        })
      })

      res.on('error', err => { file.destroy(); fs.unlink(tmp, () => {}); reject(err) })
    })

    req.on('error', err => { file.destroy(); fs.unlink(tmp, () => {}); reject(err) })
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

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

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data', d => hash.update(d))
    stream.on('end',  () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fileOk(filePath, expectedSha1) {
  if (!fs.existsSync(filePath)) return false
  if (!expectedSha1) return true
  return (await sha1File(filePath)) === expectedSha1
}

// ─── Install principal ────────────────────────────────────────

async function install(versionId, onProgress) {
  try {
    const mcDir       = config.minecraftDir
    const versionsDir = path.join(mcDir, 'versions', versionId)
    fs.mkdirSync(versionsDir, { recursive: true })

    // 1. Metadatos
    onProgress({ message: 'Descargando metadatos...', percent: 2 })
    const manifestRes = await versionManager.fetchVersions(true)
    const ver         = manifestRes.versions.find(v => v.id === versionId)
    if (!ver) return { success: false, message: `Versión ${versionId} no encontrada.` }

    const metadata = await versionManager.getVersionMetadata(ver.url)
    fs.writeFileSync(path.join(versionsDir, `${versionId}.json`), JSON.stringify(metadata, null, 2))

    // 2. Client JAR
    onProgress({ message: 'Descargando cliente de Minecraft...', percent: 5 })
    const clientInfo = metadata.downloads?.client
    const clientJar  = path.join(versionsDir, `${versionId}.jar`)

    if (!(await fileOk(clientJar, clientInfo?.sha1))) {
      await download(clientInfo.url, clientJar, p =>
        onProgress({ message: `Cliente: ${p}%`, percent: 5 + Math.floor(p * 0.2) })
      )
    }

    // 3. Librerías — 16 en paralelo
    onProgress({ message: 'Descargando librerías...', percent: 25 })
    const libs    = (metadata.libraries || []).filter(l => l.downloads?.artifact)
    const libsDir = path.join(mcDir, 'libraries')
    let libsDone  = 0

    await parallel(libs.map(lib => async () => {
      const { path: relPath, url, sha1 } = lib.downloads.artifact
      const libPath = path.join(libsDir, relPath)
      fs.mkdirSync(path.dirname(libPath), { recursive: true })
      if (!(await fileOk(libPath, sha1))) {
        try { await download(url, libPath) } catch {}
      }
      libsDone++
      if (libsDone % 5 === 0 || libsDone === libs.length) {
        onProgress({
          message: `Librerías: ${libsDone}/${libs.length}`,
          percent: 25 + Math.floor((libsDone / libs.length) * 30),
        })
      }
    }), CONCURRENCY_LIBS)

    // 4. Assets — 32 en paralelo
    onProgress({ message: 'Preparando assets...', percent: 55 })
    if (metadata.assetIndex) {
      await downloadAssets(metadata.assetIndex, mcDir, onProgress)
    }

    versionManager.markInstalled(versionId)
    return { success: true, message: `Minecraft ${versionId} instalado correctamente.` }

  } catch (err) {
    return { success: false, message: `Error: ${err.message}` }
  }
}

async function downloadAssets(assetIndexInfo, mcDir, onProgress) {
  const indexDir = path.join(mcDir, 'assets', 'indexes')
  const objDir   = path.join(mcDir, 'assets', 'objects')
  fs.mkdirSync(indexDir, { recursive: true })
  fs.mkdirSync(objDir,   { recursive: true })

  const indexFile = path.join(indexDir, `${assetIndexInfo.id}.json`)
  if (!fs.existsSync(indexFile)) await download(assetIndexInfo.url, indexFile)

  const objects = Object.values(JSON.parse(fs.readFileSync(indexFile, 'utf-8')).objects || {})

  // Solo descargar los que no existen
  const pending = objects.filter(({ hash }) =>
    !fs.existsSync(path.join(objDir, hash.slice(0, 2), hash))
  )

  if (pending.length === 0) {
    onProgress({ message: 'Assets ya descargados ✓', percent: 95 })
    return
  }

  let done = 0
  onProgress({ message: `Descargando ${pending.length} assets...`, percent: 55 })

  await parallel(pending.map(({ hash }) => async () => {
    const prefix  = hash.slice(0, 2)
    const objPath = path.join(objDir, prefix, hash)
    fs.mkdirSync(path.dirname(objPath), { recursive: true })
    try {
      await download(`https://resources.download.minecraft.net/${prefix}/${hash}`, objPath)
    } catch {}

    done++
    if (done % 50 === 0 || done === pending.length) {
      onProgress({
        message: `Assets: ${done}/${pending.length}`,
        percent: 55 + Math.floor((done / pending.length) * 40),
      })
    }
  }), CONCURRENCY_ASSETS)
}

module.exports = { install }
