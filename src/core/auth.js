const https    = require('https')
const http     = require('http')
const crypto   = require('crypto')
const { shell, BrowserWindow } = require('electron')

const config = require('../utils/config')

// ─── Constantes Microsoft / Xbox / Minecraft ──────────────────
const MS_CLIENT_ID    = '00000000402b5328'   // Client ID público oficial de Minecraft Launcher
const MS_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const MS_SCOPE        = 'XboxLive.signin%20offline_access'

const URLS = {
  msAuth:   'https://login.live.com/oauth20_authorize.srf',
  msToken:  'https://login.live.com/oauth20_token.srf',
  xblAuth:  'https://user.auth.xboxlive.com/user/authenticate',
  xstsAuth: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcAuth:   'https://api.minecraftservices.com/authentication/login_with_xbox',
  mcProfile:'https://api.minecraftservices.com/minecraft/profile',
  mcOwned:  'https://api.minecraftservices.com/entitlements/mcstore',
}

// ─── HTTP helper ──────────────────────────────────────────────

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const proto  = parsed.protocol === 'https:' ? https : http

    const reqOptions = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || (body ? 'POST' : 'GET'),
      headers:  options.headers || {},
    }

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr)
      if (!reqOptions.headers['Content-Type']) {
        reqOptions.headers['Content-Type'] = 'application/json'
      }
    }

    const req = proto.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.message || parsed.error || data}`))
          } else {
            resolve(parsed)
          }
        } catch {
          reject(new Error(`Respuesta inválida: ${data.slice(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

// ─── Flujo Microsoft OAuth (ventana de Electron) ──────────────

function openMicrosoftLogin() {
  return new Promise((resolve, reject) => {
    const authUrl =
      `${URLS.msAuth}?client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}` +
      `&scope=${MS_SCOPE}` +
      `&prompt=select_account`

    const win = new BrowserWindow({
      width:  500,
      height: 650,
      title:  'Iniciar sesión con Microsoft',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    win.loadURL(authUrl)
    win.show()

    // Detectar cuando Microsoft redirige con el code
    win.webContents.on('will-redirect', (event, url) => {
      checkForCode(url, win, resolve, reject)
    })

    win.webContents.on('will-navigate', (event, url) => {
      checkForCode(url, win, resolve, reject)
    })

    // También revisar la URL actual al cargar
    win.webContents.on('did-navigate', (event, url) => {
      checkForCode(url, win, resolve, reject)
    })

    win.on('closed', () => {
      reject(new Error('Ventana cerrada por el usuario.'))
    })
  })
}

function checkForCode(url, win, resolve, reject) {
  try {
    const parsed = new URL(url)
    if (!url.startsWith(MS_REDIRECT_URI)) return

    const code  = parsed.searchParams.get('code')
    const error = parsed.searchParams.get('error')

    if (error) {
      win.destroy()
      reject(new Error(`Error de Microsoft: ${error} — ${parsed.searchParams.get('error_description') || ''}`))
      return
    }

    if (code) {
      win.destroy()
      resolve(code)
    }
  } catch {}
}

// ─── Intercambio de code por tokens ───────────────────────────

async function getMicrosoftTokens(authCode) {
  const body =
    `client_id=${MS_CLIENT_ID}` +
    `&code=${encodeURIComponent(authCode)}` +
    `&grant_type=authorization_code` +
    `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}`

  return request(URLS.msToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body)
}

async function refreshMicrosoftToken(refreshToken) {
  const body =
    `client_id=${MS_CLIENT_ID}` +
    `&refresh_token=${encodeURIComponent(refreshToken)}` +
    `&grant_type=refresh_token` +
    `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}`

  return request(URLS.msToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body)
}

// ─── Xbox Live ────────────────────────────────────────────────

async function authenticateXboxLive(msAccessToken) {
  const res = await request(URLS.xblAuth, {
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
  }, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName:   'user.auth.xboxlive.com',
      RpsTicket:  `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType:    'JWT',
  })

  return {
    token:    res.Token,
    userHash: res.DisplayClaims.xui[0].uhs,
  }
}

// ─── XSTS ─────────────────────────────────────────────────────

async function authenticateXSTS(xblToken) {
  const res = await request(URLS.xstsAuth, {
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
  }, {
    Properties: {
      SandboxId:  'RETAIL',
      UserTokens: [xblToken],
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType:    'JWT',
  })

  return res.Token
}

// ─── Minecraft ────────────────────────────────────────────────

async function authenticateMinecraft(xstsToken, userHash) {
  const res = await request(URLS.mcAuth, {
    headers: {
      'Content-Type': 'application/json',
    },
  }, {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
  })

  return res.access_token
}

async function getMinecraftProfile(mcAccessToken) {
  return request(URLS.mcProfile, {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  })
}

async function checkMinecraftOwnership(mcAccessToken) {
  try {
    const res = await request(URLS.mcOwned, {
      headers: { Authorization: `Bearer ${mcAccessToken}` },
    })
    // Verificar que tiene la licencia de Minecraft
    return res.items && res.items.some(i =>
      i.name === 'product_minecraft' || i.name === 'game_minecraft'
    )
  } catch {
    // Si falla el check, asumir que tiene licencia (puede ser cuenta Game Pass)
    return true
  }
}

// ─── Flujo completo de login Microsoft ───────────────────────

async function loginMicrosoft() {
  try {
    // 1. Abrir ventana de login y obtener auth code
    const authCode = await openMicrosoftLogin()

    // 2. Intercambiar code por tokens de Microsoft
    const msTokens = await getMicrosoftTokens(authCode)
    const msAccessToken  = msTokens.access_token
    const msRefreshToken = msTokens.refresh_token

    // 3. Xbox Live
    const { token: xblToken, userHash } = await authenticateXboxLive(msAccessToken)

    // 4. XSTS
    const xstsToken = await authenticateXSTS(xblToken)

    // 5. Minecraft
    const mcAccessToken = await authenticateMinecraft(xstsToken, userHash)

    // 6. Verificar que tiene Minecraft
    const ownsMinecraft = await checkMinecraftOwnership(mcAccessToken)
    if (!ownsMinecraft) {
      return {
        success: false,
        message: 'Esta cuenta de Microsoft no tiene Minecraft comprado.',
      }
    }

    // 7. Obtener perfil
    const profile = await getMinecraftProfile(mcAccessToken)

    // 8. Guardar en config
    config.update({
      username:     profile.name,
      uuid:         profile.id,
      accessToken:  mcAccessToken,
      refreshToken: msRefreshToken,
      authType:     'microsoft',
    })

    return { success: true, username: profile.name, uuid: profile.id }

  } catch (err) {
    // Mensajes de error más amigables
    let message = err.message
    if (message.includes('2148916233')) message = 'Esta cuenta no tiene una cuenta de Xbox. Crea una en xbox.com primero.'
    if (message.includes('2148916235')) message = 'Xbox Live no está disponible en tu país.'
    if (message.includes('2148916236') || message.includes('2148916237')) message = 'Necesitas verificar tu edad en Xbox para jugar.'
    if (message.includes('cerrada'))    message = 'Inicio de sesión cancelado.'

    return { success: false, message }
  }
}

// ─── Refresh automático del token ─────────────────────────────

async function refreshSession() {
  const refreshToken = config.get('refreshToken')
  if (!refreshToken || config.get('authType') !== 'microsoft') {
    return { success: false, message: 'No hay sesión de Microsoft activa.' }
  }

  try {
    const msTokens      = await refreshMicrosoftToken(refreshToken)
    const { token: xblToken, userHash } = await authenticateXboxLive(msTokens.access_token)
    const xstsToken     = await authenticateXSTS(xblToken)
    const mcAccessToken = await authenticateMinecraft(xstsToken, userHash)

    config.update({
      accessToken:  mcAccessToken,
      refreshToken: msTokens.refresh_token || refreshToken,
    })

    return { success: true }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

// ─── Login offline ────────────────────────────────────────────

async function loginOffline(username) {
  if (!username || username.trim().length < 3) {
    return { success: false, message: 'El nombre debe tener al menos 3 caracteres.' }
  }

  const trimmed = username.trim()
  const uuid    = crypto
    .createHash('md5')
    .update('OfflinePlayer:' + trimmed)
    .digest('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')

  config.update({
    username:     trimmed,
    uuid,
    accessToken:  '0',
    refreshToken: '',
    authType:     'offline',
  })

  return { success: true, username: trimmed }
}

// ─── Logout ───────────────────────────────────────────────────

function logout() {
  config.clearAuth()
  return { success: true }
}

module.exports = { loginMicrosoft, loginOffline, refreshSession, logout }
