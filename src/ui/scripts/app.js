/* ═══════════════════════════════════════════
   Humita Launcher — Renderer
   ═══════════════════════════════════════════ */

const state = {
  currentPage:     'home',
  selectedVersion: null,
  versions:        [],
  isInstalling:    false,
  isLaunching:     false,
}

// ─── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await window.api.config.getAll()

  if (cfg.username) {
    // Sesión guardada → ir directo a la app
    showMainApp()
    await refreshUserState()
    setupApp()
  } else {
    // Sin sesión → mostrar pantalla de login
    showLoginScreen()
    setupLoginScreen()
  }
})

// ─── Pantallas ─────────────────────────────────────────────────
function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex'
  document.getElementById('mainApp').style.display     = 'none'
}

function showMainApp() {
  document.getElementById('loginScreen').style.display = 'none'
  document.getElementById('mainApp').style.display     = 'block'
}

// ─── Login Screen ──────────────────────────────────────────────
function setupLoginScreen() {
  const btnMs      = document.getElementById('loginBtnMs')
  const btnOffline = document.getElementById('loginBtnOffline')
  const msg        = document.getElementById('loginMsg')

  btnMs.addEventListener('click', async () => {
    btnMs.disabled      = true
    btnOffline.disabled = true
    btnMs.textContent   = '⏳ Abriendo Microsoft...'
    setLoginMsg('Se abrirá una ventana de Microsoft. Inicia sesión ahí.', 'info')

    const res = await window.api.auth.loginMicrosoft()

    btnMs.disabled      = false
    btnOffline.disabled = false
    btnMs.innerHTML     = '<span class="login-btn-icon">⊞</span> Iniciar sesión con Microsoft'

    if (res.success) {
      setLoginMsg(`✅ Bienvenido, ${res.username}!`, 'success')
      await updateSkin(res.username)
      setTimeout(async () => {
        showMainApp()
        await refreshUserState()
        setupApp()
      }, 800)
    } else {
      setLoginMsg(`❌ ${res.message}`, 'error')
    }
  })

  btnOffline.addEventListener('click', () => {
    document.getElementById('offlineModal').style.display = 'flex'
    document.getElementById('offlineUsername').focus()
  })

  document.getElementById('confirmOffline').addEventListener('click', async () => {
    const username = document.getElementById('offlineUsername').value.trim()
    const res      = await window.api.auth.loginOffline(username)
    closeModal('offlineModal')

    if (res.success) {
      setLoginMsg(`✅ Bienvenido, ${res.username}!`, 'success')
      await updateSkin(res.username)
      setTimeout(async () => {
        showMainApp()
        await refreshUserState()
        setupApp()
      }, 600)
    } else {
      setLoginMsg(`❌ ${res.message}`, 'error')
    }
  })

  document.getElementById('offlineUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('confirmOffline').click()
    if (e.key === 'Escape') closeModal('offlineModal')
  })
}

function setLoginMsg(msg, type = 'info') {
  const el = document.getElementById('loginMsg')
  el.textContent = msg
  el.style.color = type === 'success' ? 'var(--success)'
                 : type === 'error'   ? 'var(--error)'
                 : 'var(--text-secondary)'
}

// ─── Setup App (solo se llama 1 vez tras login) ───────────────
function setupApp() {
  setupNav()
  setupVersions()
  setupLogs()
  setupSidebarLogout()
  setupSettings()
}

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

// ─── Skin ─────────────────────────────────────────────────────
async function updateSkin(username) {
  const url = `https://cravatar.eu/avatar/${encodeURIComponent(username)}`
  // Sidebar
  const sidebarSkin = document.getElementById('userSkin')
  if (sidebarSkin) {
    sidebarSkin.src = url
    sidebarSkin.onerror = () => {
      sidebarSkin.src = 'https://cravatar.eu/avatar/steve'
    }
  }
  // Home avatar
  const homeAvatar = document.getElementById('homeAvatar')
  if (homeAvatar) {
    homeAvatar.src = url
    homeAvatar.onerror = () => {
      homeAvatar.src = 'https://cravatar.eu/avatar/steve'
    }
  }
}

// ─── User state ────────────────────────────────────────────────
async function refreshUserState() {
  const cfg = await window.api.config.getAll()
  if (!cfg.username) return

  // Skin
  await updateSkin(cfg.username)

  // Sidebar
  document.getElementById('userName').textContent = cfg.username
  document.getElementById('userType').textContent =
    cfg.authType === 'microsoft' ? '🟢 Microsoft' : '🟡 Offline'

  // Home
  document.getElementById('homeUsername').textContent =
    `Hola, ${cfg.username}!`
  document.getElementById('homeAuthType').textContent =
    cfg.authType === 'microsoft' ? 'Cuenta Microsoft Premium' : 'Modo Offline'

  // Play button
  document.getElementById('playBtn').disabled = false

  // Last version
  const lastVer = cfg.lastVersion
  if (lastVer) {
    state.selectedVersion = lastVer
    document.getElementById('playVersion').textContent = lastVer
  }
}

// ─── Logout ───────────────────────────────────────────────────
function setupSidebarLogout() {
  document.getElementById('sidebarLogout').addEventListener('click', async () => {
    await window.api.auth.logout()
    // Limpiar skin
    document.getElementById('userSkin').src  = 'https://cravatar.eu/avatar/steve'
    document.getElementById('homeAvatar').src = 'https://cravatar.eu/avatar/steve'
    // Volver a pantalla de login
    showLoginScreen()
    setupLoginScreen()
  })
}

// ─── Versions ──────────────────────────────────────────────────
function setupVersions() {
  document.getElementById('refreshVersions').addEventListener('click', loadVersions)
  document.getElementById('snapshotsToggle').addEventListener('change', loadVersions)
  
  // Botón de play - lanzar juego
  document.getElementById('playBtn').addEventListener('click', (e) => {
    // Si hace clic en el dropdown, no lanzar
    if (e.target.closest('.play-dropdown')) return
    if (state.selectedVersion) launchGame(state.selectedVersion)
  })
  
  // Botón dropdown - abrir versiones
  document.getElementById('playDropdown').addEventListener('click', () => {
    navigate('versions')
    if (state.versions.length === 0) loadVersions()
  })
}

async function loadVersions() {
  const list = document.getElementById('versionsList')
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Cargando versiones...</p></div>`

  const snapshots = document.getElementById('snapshotsToggle').checked
  const res       = await window.api.versions.fetch(snapshots)

  if (!res.success) {
    list.innerHTML = `<div class="loading-state"><p style="color:var(--error)">❌ ${res.error}</p></div>`
    return
  }

  state.versions = res.versions
  list.innerHTML = ''

  res.versions.forEach(ver => {
    const row      = document.createElement('div')
    row.className  = 'version-row'
    row.dataset.id = ver.id
    const isLatest = ver.id === res.latest

    row.innerHTML = `
      ${isLatest ? `<span class="ver-latest">⭐ LATEST</span>` : ''}
      <span class="ver-id">${ver.id}</span>
      <span class="ver-type ${ver.type}">${ver.type}</span>
      ${ver.installed ? `<span class="ver-installed">✅</span>` : ''}
    `
    row.addEventListener('click', () => selectVersion(ver))
    list.appendChild(row)
  })
}

function selectVersion(ver) {
  document.querySelectorAll('.version-row').forEach(r => r.classList.remove('selected'))
  document.querySelector(`.version-row[data-id="${ver.id}"]`)?.classList.add('selected')
  state.selectedVersion = ver.id

  // Actualizar botón de play
  document.getElementById('playVersion').textContent = ver.id
  document.getElementById('playBtn').disabled = !ver.installed
  
  // Guardar como última versión
  window.api.config.set('lastVersion', ver.id)

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
  document.getElementById('installBtn').addEventListener('click',   () => installVersion(ver))
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
  label.style.color  = ''

  window.api.installer.onProgress(({ message, percent }) => {
    label.textContent = message
    fill.style.width  = `${percent}%`
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
    setTimeout(() => { wrap.style.display = 'none'; label.style.color = '' }, 4000)
  }
}

async function launchGame(versionId) {
  if (state.isLaunching) return
  const cfg = await window.api.config.getAll()

  state.isLaunching = true
  
  // Referencias a elementos
  const playBtn = document.getElementById('playBtn')
  const playLoading = document.getElementById('playLoading')
  const playProgress = document.getElementById('playProgress')
  const playVersionInfo = document.getElementById('playVersionInfo')
  const playDropdown = document.getElementById('playDropdown')
  const playText = playBtn?.querySelector('.play-text')
  
  // Cambiar estado del botón a cargando
  if (playBtn) {
    playBtn.classList.add('loading')
    playBtn.disabled = true
  }
  
  if (playText) playText.textContent = 'LANZANDO'
  
  // Ocultar versión y dropdown
  if (playVersionInfo) playVersionInfo.style.display = 'none'
  if (playDropdown) playDropdown.style.display = 'none'
  
  // Mostrar barra de progreso
  if (playLoading) playLoading.style.display = 'flex'
  
  // Animar progreso inicial (crecer lentamente)
  let currentProgress = 10
  const progressInterval = setInterval(() => {
    if (currentProgress < 90) {
      currentProgress += Math.random() * 20
      if (playProgress) playProgress.style.width = currentProgress + '%'
    }
  }, 300)

  if (cfg.authType === 'microsoft') {
    // Timeout de 5 segundos para refresh
    const refreshPromise = window.api.auth.refresh()
    const timeoutPromise = new Promise(resolve => 
      setTimeout(() => resolve({ success: false, message: 'Timeout' }), 5000)
    )
    
    await Promise.race([refreshPromise, timeoutPromise])
  }

  window.api.launcher.onLog(line => {
    // Actualizar progreso basado en logs
    if (line.includes('Iniciando') || line.includes('Loading')) {
      currentProgress = Math.max(currentProgress, 50)
    }
    if (playProgress && currentProgress < 90) {
      playProgress.style.width = currentProgress + '%'
    }
  })
  
  const res = await window.api.launcher.launch(versionId)
  clearInterval(progressInterval)

  state.isLaunching = false
  
  // Completar la barra de progreso
  if (playProgress) playProgress.style.width = '100%'
  
  // Restaurar botón después de 1.5s
  setTimeout(() => {
    if (playBtn) {
      playBtn.classList.remove('loading')
      playBtn.disabled = false
      playText.textContent = 'JUGAR'
    }
    
    // Mostrar versión y dropdown nuevamente
    if (playVersionInfo) playVersionInfo.style.display = 'flex'
    if (playDropdown) playDropdown.style.display = 'flex'
    
    if (playLoading) playLoading.style.display = 'none'
    if (playProgress) playProgress.style.width = '0%'
  }, 1500)
}

// ─── Settings ──────────────────────────────────────────────────
async function loadSettingsValues() {
  const cfg = await window.api.config.getAll()
  document.getElementById('javaPath').value = cfg.javaPath     || ''
  document.getElementById('ramMin').value   = cfg.ramMin       || '1G'
  document.getElementById('ramMax').value   = cfg.ramMax       || '2G'
  document.getElementById('mcDir').value    = cfg.minecraftDir || ''
}

function setupSettings() {
  document.getElementById('detectJava').addEventListener('click', async () => {
    const note = document.getElementById('javaNote')
    note.textContent = 'Buscando Java...'
    note.style.color = ''
    const javaPath = await window.api.java.find()
    if (javaPath) {
      document.getElementById('javaPath').value = javaPath
      const version = await window.api.java.getVersion(javaPath)
      note.textContent = `✅ Java ${version}`
      note.style.color = 'var(--success)'
    } else {
      note.textContent = '❌ Java no encontrado. Descárgalo desde java.com'
      note.style.color = 'var(--error)'
    }
  })

  document.getElementById('saveJava').addEventListener('click', async () => {
    await window.api.config.set('javaPath', document.getElementById('javaPath').value.trim())
    const note = document.getElementById('javaNote')
    note.textContent = '✅ Guardado.'
    note.style.color = 'var(--success)'
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
  const clearBtn = document.getElementById('clearLogs')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const output = document.getElementById('logsOutput')
      if (output) output.textContent = ''
    })
  }
}

function appendLog(line) {
  const out    = document.getElementById('logsOutput')
  out.textContent += line + '\n'
  out.scrollTop    = out.scrollHeight
}

// ─── Modal ─────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).style.display = 'none'
}
