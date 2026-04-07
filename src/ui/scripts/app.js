/* ═══════════════════════════════════════════
   Humita Launcher — Renderer (Frontend)
   ═══════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────
const state = {
  currentPage:    'home',
  selectedVersion: null,
  versions:        [],
  isInstalling:    false,
  isLaunching:     false,
}

// ─── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupNav()
  setupSettings()
  setupVersions()
  setupLogs()
  setupAuth()
  await refreshUserState()
  
  // Show auth modal on first launch if no user is logged in
  setTimeout(async () => {
    const cfg = await window.api.config.getAll()
    if (!cfg.username && !cfg.hasShownAuthOnFirstLaunch) {
      const authModal = document.getElementById('authModal')
      if (authModal) {
        authModal.style.display = 'flex'
      }
      // Mark that we've shown the auth modal on first launch
      await window.api.config.set('hasShownAuthOnFirstLaunch', 'true')
    }
  }, 500)
})

// ─── Navigation ────────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))

  document.getElementById(`page-${page}`)?.classList.add('active')
  document.querySelector(`.nav-btn[data-page="${page}"]`)?.classList.add('active')

  state.currentPage = page
  if (page === 'versions' && state.versions.length === 0) loadVersions()
  if (page === 'settings') loadSettingsValues()
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page))
  })
}

// ─── Titlebar ──────────────────────────────────────────────────

// ─── User state ────────────────────────────────────────────────
async function updatePlayerSkin(identifier) {
  const skinImg = document.getElementById('userSkin')
  if (!skinImg) return
  skinImg.src = `https://cravatar.eu/avatar/${encodeURIComponent(identifier)}.png`
}

async function refreshUserState() {
  const cfg = await window.api.config.getAll()

  // Sidebar user chip
  const avatar   = document.getElementById('userSkin')
  const nameEl   = document.getElementById('userName')
  const playBtn  = document.getElementById('playBtn')
  const homeName = document.getElementById('homeUsername')
  const homeAuth = document.getElementById('homeAuthType')
  const homeBadge= document.getElementById('homeBadge')

  if (cfg.username) {
    if (avatar && avatar.tagName === 'IMG') {
      await updatePlayerSkin(cfg.username)
    }
    nameEl.textContent  = cfg.username
    homeName.textContent= `Hola, ${cfg.username}!`
    homeAuth.textContent= cfg.authType === 'microsoft' ? 'Cuenta Microsoft' : 'Modo Offline'
    homeBadge.textContent = cfg.authType === 'microsoft' ? '🟢 MS' : '🟡 Offline'
    playBtn.disabled    = false
  } else {
    if (avatar && avatar.tagName === 'IMG') {
      avatar.src = 'https://cravatar.eu/avatar/steve.png'
    }
    nameEl.textContent  = 'Sin sesión'
    homeName.textContent= 'No has iniciado sesión'
    homeAuth.textContent= 'Ve a Ajustes para iniciar sesión'
    homeBadge.textContent = '—'
    playBtn.disabled    = true
  }

  const lastVer = cfg.lastVersion
  if (lastVer) {
    document.getElementById('homeVersion').textContent = lastVer
    state.selectedVersion = lastVer
  }
}

// ─── Auth ──────────────────────────────────────────────────────
function setupAuth() {
  // Toggle auth modal when clicking status card
  const statusCard = document.getElementById('statusCardHome')
  const authModal = document.getElementById('authModal')
  if (statusCard && authModal) {
    statusCard.addEventListener('click', () => {
      authModal.style.display = authModal.style.display === 'none' ? 'flex' : 'none'
    })
  }

  document.getElementById('btnMicrosoft').addEventListener('click', async () => {
    const btn = document.getElementById('btnMicrosoft')
    btn.disabled = true
    btn.textContent = '⏳ Esperando...'
    setAuthMsg('Se abrirá una ventana de Microsoft. Inicia sesión ahí.', 'info')
    const res = await window.api.auth.loginMicrosoft()
    btn.disabled = false
    btn.textContent = '🪟  Microsoft'
    if (res.success) {
      setAuthMsg(`✅ Sesión iniciada como ${res.username}`, 'success')
      await refreshUserState()
      updateAuthUI(true)
    } else {
      setAuthMsg(`❌ ${res.message}`, 'error')
    }
  })

  document.getElementById('btnOffline').addEventListener('click', () => {
    document.getElementById('offlineModal').style.display = 'flex'
    document.getElementById('offlineUsername').focus()
  })

  document.getElementById('confirmOffline').addEventListener('click', async () => {
    const username = document.getElementById('offlineUsername').value.trim()
    const res = await window.api.auth.loginOffline(username)
    closeModal('offlineModal')
    if (res.success) {
      updatePlayerSkin(username)
      setAuthMsg(`✅ Sesión iniciada como ${res.username}`, 'success')
      await refreshUserState()
      updateAuthUI(true)
    } else {
      setAuthMsg(`❌ ${res.message}`, 'error')
    }
  })

  document.getElementById('offlineUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('confirmOffline').click()
    if (e.key === 'Escape') closeModal('offlineModal')
  })

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await window.api.auth.logout()
    setAuthMsg('Sesión cerrada.', 'info')
    await refreshUserState()
    updateAuthUI(false)
  })
}

function updateAuthUI(loggedIn) {
  const logoutBtn   = document.getElementById('btnLogout')
  const authStatus  = document.getElementById('authStatus')
  const authModal   = document.getElementById('authModal')
  const homeUsername = document.getElementById('homeUsername')
  const homeAuthType = document.getElementById('homeAuthType')
  
  logoutBtn.disabled= !loggedIn
  
  // Close auth modal after successful login
  if (loggedIn && authModal) {
    authModal.style.display = 'none'
  }

  window.api.config.getAll().then(cfg => {
    if (cfg.username) {
      const statusText = `✅ Sesión iniciada como ${cfg.username} (${cfg.authType})`
      if (authStatus) authStatus.textContent = statusText
      if (homeUsername) homeUsername.textContent = `${cfg.username}`
      if (homeAuthType) homeAuthType.textContent = `${cfg.authType}`
    } else {
      if (authStatus) authStatus.textContent = '❌ No has iniciado sesión'
      if (homeUsername) homeUsername.textContent = 'No has iniciado sesión'
      if (homeAuthType) homeAuthType.textContent = 'Haz clic para iniciar sesión'
    }
  })
}

function setAuthMsg(msg, type = 'info') {
  const el = document.getElementById('authMsg')
  el.textContent = msg
  el.style.color = type === 'success' ? 'var(--success)' :
                   type === 'error'   ? 'var(--error)'   : 'var(--text-secondary)'
}

// ─── Versions ──────────────────────────────────────────────────
function setupVersions() {
  document.getElementById('refreshVersions').addEventListener('click', loadVersions)
  document.getElementById('snapshotsToggle').addEventListener('change', loadVersions)

  document.getElementById('playBtn').addEventListener('click', () => {
    if (state.selectedVersion) launchGame(state.selectedVersion)
    else navigate('versions')
  })
}

async function loadVersions() {
  const list = document.getElementById('versionsList')
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Cargando versiones...</p></div>`

  const snapshots = document.getElementById('snapshotsToggle').checked
  const res       = await window.api.versions.fetch(snapshots)

  if (!res.success) {
    list.innerHTML = `<div class="loading-state"><p style="color:var(--error)">❌ Error: ${res.error}</p></div>`
    return
  }

  state.versions = res.versions
  list.innerHTML = ''

  res.versions.forEach(ver => {
    const row        = document.createElement('div')
    row.className    = 'version-row'
    row.dataset.id   = ver.id

    const isLatest   = ver.id === res.latest
    const installed  = ver.installed

    row.innerHTML = `
      ${isLatest ? `<span class="ver-latest">⭐ LATEST</span>` : ''}
      <span class="ver-id">${ver.id}</span>
      <span class="ver-type ${ver.type}">${ver.type}</span>
      ${installed ? `<span class="ver-installed">✅ Instalado</span>` : ''}
    `
    row.addEventListener('click', () => selectVersion(ver))
    list.appendChild(row)
  })
}

function selectVersion(ver) {
  document.querySelectorAll('.version-row').forEach(r => r.classList.remove('selected'))
  document.querySelector(`.version-row[data-id="${ver.id}"]`)?.classList.add('selected')
  state.selectedVersion = ver.id

  const detail = document.getElementById('versionDetail')
  const date   = new Date(ver.releaseTime).toLocaleDateString('es-CL')

  detail.innerHTML = `
    <div class="detail-title">${ver.id}</div>
    <div class="detail-meta">
      <span><b>Tipo:</b> ${ver.type}</span>
      <span><b>Fecha:</b> ${date}</span>
      <span><b>Estado:</b> ${ver.installed ? '✅ Instalado' : '⬇ No instalado'}</span>
    </div>
    <div class="detail-actions">
      <button class="btn-primary"   id="installBtn">${ver.installed ? '♻ Reinstalar' : '⬇ Instalar'}</button>
      <button class="btn-secondary" id="launchVerBtn" ${!ver.installed ? 'disabled' : ''}>▶ Lanzar</button>
    </div>
  `

  document.getElementById('installBtn').addEventListener('click', () => installVersion(ver))
  document.getElementById('launchVerBtn').addEventListener('click', () => launchGame(ver.id))
}

async function installVersion(ver) {
  if (state.isInstalling) return
  state.isInstalling = true

  const wrap  = document.getElementById('progressWrap')
  const fill  = document.getElementById('progressFill')
  const label = document.getElementById('progressLabel')

  wrap.style.display = 'block'
  fill.style.width   = '0%'

  window.api.installer.onProgress(({ message, percent }) => {
    label.textContent  = message
    fill.style.width   = `${percent}%`
  })

  const res = await window.api.installer.install(ver.id)
  state.isInstalling = false

  if (res.success) {
    label.textContent = `✅ ${res.message}`
    fill.style.width  = '100%'
    ver.installed     = true
    await window.api.config.set('lastVersion', ver.id)
    await refreshUserState()
    setTimeout(() => { wrap.style.display = 'none' }, 3000)
    selectVersion(ver)
  } else {
    label.style.color = 'var(--error)'
    label.textContent = `❌ ${res.message}`
    setTimeout(() => {
      wrap.style.display  = 'none'
      label.style.color   = ''
    }, 4000)
  }
}

async function launchGame(versionId) {
  if (state.isLaunching) return
  const cfg = await window.api.config.getAll()
  if (!cfg.username) {
    navigate('settings')
    setAuthMsg('⚠️ Inicia sesión primero.', 'error')
    return
  }

  state.isLaunching = true
  navigate('logs')
  appendLog(`[HUMITA] Lanzando Minecraft ${versionId}...`)

  // Refresh silencioso si la cuenta es Microsoft
  if (cfg.authType === 'microsoft') {
    appendLog('[AUTH] Verificando sesión de Microsoft...')
    const refreshed = await window.api.auth.refresh()
    appendLog(refreshed ? '[AUTH] Token renovado.' : '[AUTH] Usando token existente.')
  }

  window.api.launcher.onLog(line => appendLog(line))
  const res = await window.api.launcher.launch(versionId)

  state.isLaunching = false
  if (!res.success) appendLog(`[ERROR] ${res.message}`)
}

// ─── Settings ──────────────────────────────────────────────────
async function loadSettingsValues() {
  const cfg = await window.api.config.getAll()

  document.getElementById('javaPath').value = cfg.javaPath  || ''
  document.getElementById('ramMin').value   = cfg.ramMin    || '1G'
  document.getElementById('ramMax').value   = cfg.ramMax    || '2G'
  document.getElementById('mcDir').value    = cfg.minecraftDir || ''

  const authStatus = document.getElementById('authStatus')
  if (cfg.username) {
    authStatus.textContent = `✅ Sesión iniciada como ${cfg.username} (${cfg.authType})`
    document.getElementById('btnLogout').disabled = false
  } else {
    authStatus.textContent = '❌ No has iniciado sesión'
  }
}

function setupSettings() {
  document.getElementById('detectJava').addEventListener('click', async () => {
    const note = document.getElementById('javaNote')
    note.textContent = 'Buscando Java...'
    const javaPath = await window.api.java.find()
    if (javaPath) {
      document.getElementById('javaPath').value = javaPath
      const version = await window.api.java.getVersion(javaPath)
      note.textContent = `✅ Encontrado: Java ${version}`
      note.style.color = 'var(--success)'
    } else {
      note.textContent = '❌ Java no encontrado. Descárgalo desde java.com'
      note.style.color = 'var(--error)'
    }
  })

  document.getElementById('saveJava').addEventListener('click', async () => {
    const val = document.getElementById('javaPath').value.trim()
    await window.api.config.set('javaPath', val)
    document.getElementById('javaNote').textContent = '✅ Guardado.'
    document.getElementById('javaNote').style.color = 'var(--success)'
  })

  document.getElementById('saveRam').addEventListener('click', async () => {
    await window.api.config.set('ramMin', document.getElementById('ramMin').value.trim())
    await window.api.config.set('ramMax', document.getElementById('ramMax').value.trim())
  })

  document.getElementById('saveMcDir').addEventListener('click', async () => {
    await window.api.config.set('minecraftDir', document.getElementById('mcDir').value.trim())
  })
}

// ─── Logs ──────────────────────────────────────────────────────
function setupLogs() {
  document.getElementById('clearLogs').addEventListener('click', () => {
    document.getElementById('logsOutput').textContent = ''
  })
}

function appendLog(line) {
  const out = document.getElementById('logsOutput')
  out.textContent += line + '\n'
  out.scrollTop    = out.scrollHeight
}

// ─── Modal ──────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).style.display = 'none'
}
