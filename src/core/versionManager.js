const https   = require('https')
const config  = require('../utils/config')

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'

let _manifestCache = null

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function fetchVersions(includeSnapshots = false) {
  try {
    const manifest = await fetchJSON(MANIFEST_URL)
    _manifestCache = manifest

    const versions = manifest.versions
      .filter(v => v.type === 'release' || (includeSnapshots && v.type === 'snapshot'))
      .map(v => ({
        id:          v.id,
        type:        v.type,
        url:         v.url,
        releaseTime: v.releaseTime,
        installed:   isInstalled(v.id),
      }))

    return { success: true, versions, latest: manifest.latest?.release }
  } catch (err) {
    return { success: false, error: err.message, versions: [] }
  }
}

async function getVersionMetadata(url) {
  return fetchJSON(url)
}

function isInstalled(versionId) {
  const installed = config.get('installedVersions') || []
  return installed.includes(versionId)
}

function markInstalled(versionId) {
  const installed = config.get('installedVersions') || []
  if (!installed.includes(versionId)) {
    config.set('installedVersions', [...installed, versionId])
  }
}

function getLatest() {
  return _manifestCache?.latest?.release || null
}

module.exports = { fetchVersions, getVersionMetadata, isInstalled, markInstalled, getLatest }
