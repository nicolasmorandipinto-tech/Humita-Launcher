const path = require('path')
const os   = require('os')
const fs   = require('fs')

const CONFIG_DIR  = path.join(os.homedir(), '.humita-launcher')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULTS = {
  username:          '',
  uuid:              '',
  accessToken:       '',
  refreshToken:      '',
  authType:          'offline',
  lastVersion:       '',
  minecraftDir:      path.join(os.homedir(), '.minecraft'),
  javaPath:          '',
  ramMin:            '1G',
  ramMax:            '2G',
  installedVersions: [],
}

class Config {
  constructor() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    this._data = this._load()
  }

  _load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw  = fs.readFileSync(CONFIG_FILE, 'utf-8')
        const data = JSON.parse(raw)
        return { ...DEFAULTS, ...data }
      }
    } catch {}
    return { ...DEFAULTS }
  }

  _save() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this._data, null, 2), 'utf-8')
  }

  get store() { return { ...this._data } }

  get(key) { return this._data[key] }

  set(key, value) {
    this._data[key] = value
    this._save()
  }

  update(obj) {
    Object.assign(this._data, obj)
    this._save()
  }

  clearAuth() {
    this.update({ username: '', uuid: '', accessToken: '', refreshToken: '', authType: 'offline' })
  }

  get isLoggedIn() { return Boolean(this._data.username) }
  get minecraftDir() { return this._data.minecraftDir }
}

module.exports = new Config()
