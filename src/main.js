import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeImage,
  protocol,
  session
} from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import parseTorrent from 'parse-torrent'
import { findUnsafeFilePath, isRiskyToOpen, isUnsafeDownloadDir, sanitizeTorrent } from './security.js'
import { createEngine, WEBRTC_SUPPORT } from './engine.js'
import { isJpeg, pickPreviewSource, playableFileIndex } from './media.js'
import {
  MEDIA_SCHEME,
  MEDIA_SCHEME_PRIVILEGES,
  createStreamServer,
  findVlc,
  launchVlc,
  mediaRequestHandler
} from './streaming.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'

// Check launch used by the build: throwaway profile, then exit.
const smokeTest = process.argv.includes('--smoke-test')
const smokeVideo = process.argv.find((arg) => arg.startsWith('--smoke-video='))?.slice('--smoke-video='.length)

app.setName('WebTorrent 2')
if (smokeTest) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'webtorrent2-smoke-')))
}

// Must happen before the app is ready.
protocol.registerSchemesAsPrivileged([MEDIA_SCHEME_PRIVILEGES])

const pendingFiles = []
let mainWindow = null
let tray = null
let client = null
let isQuitting = false
let updateTimer = null
let streamServer = null
let engineStopped = false
let soundsReady = false
let startupSoundSent = false
const pendingSounds = []

let configFile = null
let sessionFile = null
let torrentsDir = null
let postersDir = null
let config = null

const entries = new Map()
let nextEntryId = 1

// A real .torrent is rarely more than a few MB: above this, refuse to load it in memory.
const MAX_TORRENT_FILE_BYTES = 32 * 1024 * 1024
const MAX_POSTER_BYTES = 2 * 1024 * 1024
const RENDERER_PATH = path.join(__dirname, 'renderer', 'index.html')

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (client) {
    handleTorrentFile(filePath).catch((err) => reportError(err))
  } else {
    pendingFiles.push(filePath)
  }
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow()
    openTorrentsFromArguments(argv).catch((err) => reportError(err))
  })
  bootstrap().catch((err) => {
    console.error(err)
    if (smokeTest) return app.exit(1)
    dialog.showErrorBox('WebTorrent 2', String(err?.message || err))
    app.quit()
  })
}

async function bootstrap () {
  await app.whenReady()

  lockDownWebContents()

  if (isMac && !app.isPackaged) {
    const devIcon = path.join(__dirname, '..', 'build', 'icon.png')
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon)
  }

  initPaths()
  loadConfig()
  createClient()
  protocol.handle(MEDIA_SCHEME, mediaRequestHandler({ findFile, posterFile }))
  streamServer = createStreamServer(findFile)
  createWindow()
  createTray()
  buildMenu()
  registerIpc()
  if (smokeTest) runSmokeTest()

  updateTimer = setInterval(() => {
    pushUpdate()
  }, 1000)

  app.on('activate', () => showWindow())
  app.on('before-quit', () => { isQuitting = true })
  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
  // The WebRTC native module keeps threads alive while a connection is open, and
  // exiting with them running hangs the app. Stop the engine first, then exit.
  app.on('will-quit', (event) => {
    if (engineStopped) return
    event.preventDefault()
    stopEngine().finally(() => app.exit(0))
  })

  await restoreSession()

  await openTorrentsFromArguments(process.argv)

  const queued = pendingFiles.splice(0)
  for (const filePath of queued) {
    try {
      await handleTorrentFile(filePath)
    } catch (err) {
      reportError(err)
    }
  }

  pushUpdate()
}

async function openTorrentsFromArguments (argv) {
  const args = Array.isArray(argv) ? argv : []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--open-torrent') {
      const filePath = args[index + 1]
      index += 1
      if (!filePath) continue
      try {
        await handleTorrentFile(path.resolve(filePath))
      } catch (err) {
        reportError(err)
      }
      continue
    }

    if (isTorrentArgument(argument)) {
      try {
        await handleTorrentFile(path.resolve(argument))
      } catch (err) {
        reportError(err)
      }
    }
  }
}

function isTorrentArgument (argument) {
  return (
    typeof argument === 'string' &&
    argument.toLowerCase().endsWith('.torrent') &&
    fs.existsSync(argument)
  )
}

function initPaths () {
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })

  configFile = path.join(userData, 'config.json')
  sessionFile = path.join(userData, 'session.json')
  torrentsDir = path.join(userData, 'torrents')
  postersDir = path.join(userData, 'posters')
  fs.mkdirSync(torrentsDir, { recursive: true })
  fs.mkdirSync(postersDir, { recursive: true })
}

function loadConfig () {
  const fallback = {
    version: 1,
    downloadPath: app.getPath('downloads'),
    soundNotifications: true
  }

  try {
    config = { ...fallback, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }
  } catch {
    config = fallback
  }

  if (!config.downloadPath || isUnsafeDownloadDir(config.downloadPath, os.homedir())) {
    config.downloadPath = fallback.downloadPath
  }
  config.soundNotifications = config.soundNotifications !== false

  try {
    fs.mkdirSync(config.downloadPath, { recursive: true })
  } catch {
    config.downloadPath = fallback.downloadPath
    fs.mkdirSync(config.downloadPath, { recursive: true })
  }

  saveConfig()
}

function saveConfig () {
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('config write failed', err)
  }
}

function createClient () {
  client = createEngine()

  client.on('error', (err) => reportError(err))
  client.on('warning', (err) => console.warn('webtorrent warning:', err?.message || err))
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow.loadFile(RENDERER_PATH)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.on('did-start-loading', () => { soundsReady = false })

  // If the page fails to load, show the window anyway and log why:
  // otherwise the app looks like it does nothing at all.
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`did-fail-load ${code} ${description} ${url}`)
    mainWindow.show()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('render-process-gone', details)
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('preload-error', preloadPath, error)
  })

  mainWindow.webContents.on('console-message', (event) => {
    console.log('[renderer]', typeof event === 'object' && event?.message ? event.message : event)
  })

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('window still hidden after 5 s, forcing it visible')
      mainWindow.show()
    }
  }, 5000)

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // Hidden window: stop sending the state every second.
  mainWindow.on('show', () => pushUpdate())
  mainWindow.on('closed', () => { mainWindow = null })

  // The page never leaves the local interface. A .torrent dropped where the
  // page did not catch it arrives here as a file:// navigation: add it instead.
  mainWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    event.preventDefault()
    const target = String(event.url || legacyUrl || '')
    if (target.startsWith('file:') && target.toLowerCase().endsWith('.torrent')) {
      handleTorrentFile(fileURLToPath(target)).catch((err) => reportError(err))
    }
  })
}

function lockDownWebContents () {
  // No web permissions at all (camera, microphone, notifications, location...).
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function createTray () {
  const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  if (isMac) icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('WebTorrent 2')
  tray.on('click', () => showWindow())
  // A .torrent dropped on the menu bar icon is added too.
  tray.on('drop-files', (_event, files) => {
    for (const filePath of files) {
      handleTorrentFile(filePath).catch((err) => reportError(err))
    }
  })
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show WebTorrent 2', click: () => showWindow() },
    { label: 'Add Torrent…', click: () => pickTorrentFiles() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
}

function buildMenu () {
  const template = []

  if (isMac) template.push({ role: 'appMenu' })

  template.push({
    label: 'File',
    submenu: [
      { label: 'Add Torrent…', accelerator: 'CmdOrCtrl+O', click: () => pickTorrentFiles() },
      { label: 'Open Download Folder', click: () => shell.openPath(config.downloadPath) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })

  template.push({ role: 'editMenu' })
  template.push({ role: 'viewMenu' })
  template.push({ role: 'windowMenu' })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Only the app's own local page may call the main process.
function isTrustedSender (event) {
  try {
    const url = new URL(event?.senderFrame?.url || '')
    return url.protocol === 'file:' && path.normalize(fileURLToPath(url)) === RENDERER_PATH
  } catch {
    return false
  }
}

function handle (channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`IPC refused: ${channel}`)
    return listener(event, ...args)
  })
}

function registerIpc () {
  handle('torrents:list', () => listTorrents())

  handle('torrents:add-text', async (_event, text) => {
    const value = String(text || '').trim()
    if (!value) return { ok: false, error: 'Nothing to add.' }
    if (!looksLikeTorrentId(value)) {
      return { ok: false, error: 'This is not a valid magnet link or info hash.' }
    }
    try {
      await addTorrent(value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  handle('torrents:pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Torrent',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Torrents', extensions: ['torrent'] }]
    })
    if (result.canceled) return { ok: true, added: 0 }
    let added = 0
    for (const filePath of result.filePaths) {
      try {
        await handleTorrentFile(filePath)
        added += 1
      } catch (err) {
        reportError(err)
      }
    }
    return { ok: true, added }
  })

  handle('torrents:add-path', async (_event, filePath) => {
    try {
      await handleTorrentFile(String(filePath || ''))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  handle('torrents:pause', (_event, id) => {
    const entry = entries.get(Number(id))
    if (!entry) return { ok: false }
    const changed = !entry.torrent.paused
    entry.torrent.pause()
    if (changed) notifySound('disable')
    saveSession()
    pushUpdate()
    return { ok: true }
  })

  handle('torrents:resume', (_event, id) => {
    const entry = entries.get(Number(id))
    if (!entry) return { ok: false }
    const changed = entry.torrent.paused
    entry.torrent.resume()
    if (changed) notifySound('enable')
    saveSession()
    pushUpdate()
    return { ok: true }
  })

  handle('torrents:remove', async (_event, id, deleteFiles) => {
    const removed = await removeEntry(Number(id), Boolean(deleteFiles))
    if (removed) notifySound('delete')
    return { ok: Boolean(removed) }
  })

  handle('torrents:reveal', (_event, id) => {
    const entry = entries.get(Number(id))
    if (!entry) return { ok: false }
    const filePath = firstFilePath(entry)
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
    } else {
      shell.openPath(entry.downloadPath)
    }
    return { ok: true }
  })

  handle('torrents:open', async (_event, id) => {
    const entry = entries.get(Number(id))
    if (!entry) return { ok: false }
    const filePath = firstFilePath(entry)
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: 'The file is not available yet.' }
    }
    // Several files: show the folder rather than opening one at random.
    if (entry.torrent.files.length > 1) {
      shell.showItemInFolder(filePath)
      return { ok: true }
    }
    // A script or an app coming from a torrent is never launched by a click.
    if (isRiskyToOpen(filePath)) {
      shell.showItemInFolder(filePath)
      return { ok: false, error: 'Executable file: shown in Finder, not launched.' }
    }
    const error = await shell.openPath(filePath)
    return error ? { ok: false, error } : { ok: true }
  })

  handle('torrents:play', async (_event, id) => {
    const result = await playInVlc(entries.get(Number(id)))
    if (result.ok) notifySound('play')
    return result
  })

  handle('posters:save', async (_event, id, bytes) => {
    const entry = entries.get(Number(id))
    const infoHash = entry?.torrent?.infoHash
    if (!infoHash || !isJpeg(bytes) || bytes.length > MAX_POSTER_BYTES) return { ok: false }
    await fsp.writeFile(posterFile(infoHash), bytes)
    entry.posterVersion = Date.now()
    pushUpdate()
    return { ok: true }
  })

  handle('posters:failed', (_event, id) => {
    const entry = entries.get(Number(id))
    if (entry) entry.posterFailed = true
    return { ok: true }
  })

  handle('settings:get', () => ({
    downloadPath: config.downloadPath,
    soundNotifications: config.soundNotifications,
    version: app.getVersion()
  }))

  handle('settings:set-sounds', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid sound preference.')
    config.soundNotifications = enabled
    if (!enabled) pendingSounds.length = 0
    saveConfig()
    return { soundNotifications: config.soundNotifications }
  })

  handle('sounds:ready', () => {
    soundsReady = true
    if (!startupSoundSent) {
      startupSoundSent = true
      notifySound('startup')
    }
    for (const name of pendingSounds.splice(0)) notifySound(name)
  })

  handle('settings:choose-download', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Download Folder',
      defaultPath: config.downloadPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    if (isUnsafeDownloadDir(result.filePaths[0], os.homedir())) {
      return { ok: false, error: 'Folder refused: pick a subfolder, not your home folder or a system folder.' }
    }
    config.downloadPath = result.filePaths[0]
    saveConfig()
    pushUpdate()
    return { ok: true, downloadPath: config.downloadPath }
  })

  handle('settings:open-folder', async () => {
    const error = await shell.openPath(config.downloadPath)
    return error ? { ok: false, error } : { ok: true }
  })

  handle('clipboard:read', () => clipboard.readText())
}

function looksLikeTorrentId (value) {
  return (
    /^magnet:\?/i.test(value) ||
    /^[a-f0-9]{40}$/i.test(value) ||
    /^[a-f0-9]{64}$/i.test(value)
  )
}

async function prepareSource (source) {
  const parsed = typeof source === 'string' && fs.existsSync(source)
    ? await parseTorrent(await fsp.readFile(source))
    : await parseTorrent(source)

  // A magnet has no file list yet: it is checked on the 'metadata' event.
  if (parsed?.files) assertSafeFilePaths(parsed)
  return sanitizeTorrent(parsed)
}

function assertSafeFilePaths (torrent) {
  const unsafe = findUnsafeFilePath(torrent)
  if (unsafe !== null) {
    throw new Error(`Torrent refused: dangerous file path (${unsafe}).`)
  }
}

async function handleTorrentFile (filePath) {
  if (!filePath || !filePath.toLowerCase().endsWith('.torrent')) return
  const stat = await fsp.stat(filePath)
  if (!stat.isFile() || stat.size > MAX_TORRENT_FILE_BYTES) {
    throw new Error('Invalid or oversized .torrent file.')
  }
  const buffer = await fsp.readFile(filePath)
  const parsed = await parseTorrent(buffer)
  if (!parsed?.infoHash) throw new Error('Invalid .torrent file.')

  const destination = path.join(torrentsDir, `${parsed.infoHash}.torrent`)
  if (!fs.existsSync(destination)) {
    await fsp.writeFile(destination, buffer)
  }
  await addTorrent(destination)
}

async function addTorrent (source, options = {}) {
  const paused = Boolean(options.paused)
  const downloadPath = options.path || config.downloadPath
  const infoHash = await infoHashOf(source)

  if (infoHash) {
    const existing = await client.get(infoHash)
    if (existing) {
      focusExisting(existing)
      return null
    }
  }

  const prepared = await prepareSource(source)

  const torrent = client.add(prepared, {
    path: downloadPath,
    paused
  })

  const entry = {
    id: nextEntryId++,
    torrent,
    source,
    downloadPath,
    savedTorrentPath: isSavedTorrentPath(source) ? source : null,
    error: null,
    preview: null,
    playIndex: -1,
    posterVersion: undefined,
    posterFailed: false
  }
  entries.set(entry.id, entry)

  torrent.on('metadata', () => {
    try {
      assertSafeFilePaths(torrent)
    } catch (err) {
      // Synchronous stop, before any write: WebTorrent checks `destroyed`
      // right after this event and goes no further.
      torrent.destroy()
      reportError(err)
      removeEntry(entry.id, false).catch(() => {})
      return
    }
    entry.error = null
    entry.preview = pickPreviewSource(torrent.files)
    entry.playIndex = playableFileIndex(torrent.files)
    persistTorrentFile(entry)
    pushUpdate()
  })

  torrent.on('ready', () => {
    entry.error = null
    persistTorrentFile(entry)
    saveSession()
    pushUpdate()
  })

  let completionSoundSent = false
  torrent.on('done', () => {
    // WebTorrent also emits 'done' after verifying files already on disk. Only
    // data received from peers or web seeds counts as a new download here.
    if (!completionSoundSent && torrent.received > 0) {
      completionSoundSent = true
      notifySound('done')
    }
    saveSession()
    pushUpdate()
  })

  torrent.on('error', (err) => {
    console.error('torrent error', err)
    entry.error = String(err?.message || err)
    notifySound('error')
    pushUpdate()
  })

  torrent.on('warning', (err) => {
    console.warn('torrent warning:', err?.message || err)
  })

  torrent.on('invalidPeer', () => {})

  saveSession()
  pushUpdate()
  if (!options.restoring && !torrent.destroyed) notifySound('add')
  return entry
}

async function infoHashOf (source) {
  try {
    if (Buffer.isBuffer(source)) {
      return (await parseTorrent(source))?.infoHash || null
    }
    if (typeof source === 'string' && fs.existsSync(source)) {
      const buffer = await fsp.readFile(source)
      return (await parseTorrent(buffer))?.infoHash || null
    }
    return (await parseTorrent(source))?.infoHash || null
  } catch {
    return null
  }
}

function isSavedTorrentPath (source) {
  return typeof source === 'string' && source.startsWith(`${torrentsDir}${path.sep}`)
}

function focusExisting (torrent) {
  let target = null
  for (const entry of entries.values()) {
    if (entry.torrent === torrent) {
      target = entry
      break
    }
  }
  if (target && mainWindow) {
    mainWindow.webContents.send('torrents:focus', target.id)
  }
  showWindow()
}

function persistTorrentFile (entry) {
  if (!entries.has(entry.id)) return
  const torrent = entry.torrent
  if (!torrent.infoHash || !torrent.torrentFile) return

  const destination = path.join(torrentsDir, `${torrent.infoHash}.torrent`)
  try {
    if (!fs.existsSync(destination)) {
      fs.writeFileSync(destination, Buffer.from(torrent.torrentFile))
    }
    entry.savedTorrentPath = destination
    if (entry.source !== destination) {
      entry.source = destination
      saveSession()
    }
  } catch (err) {
    console.error('torrent file write failed', err)
  }
}

function saveSession () {
  if (!sessionFile) return
  const data = {
    version: 1,
    torrents: []
  }

  for (const entry of entries.values()) {
    if (typeof entry.source !== 'string') continue
    data.torrents.push({
      source: entry.source,
      path: entry.downloadPath,
      paused: Boolean(entry.torrent?.paused)
    })
  }

  try {
    const temporary = `${sessionFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2))
    fs.renameSync(temporary, sessionFile)
  } catch (err) {
    console.error('session write failed', err)
  }
}

async function restoreSession () {
  let data = null
  try {
    data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  } catch {
    return
  }

  const items = Array.isArray(data?.torrents) ? data.torrents : []
  for (const item of items) {
    const source = item?.source
    if (typeof source !== 'string' || !source) continue
    if (!source.startsWith('magnet:') && !fs.existsSync(source)) continue

    try {
      await addTorrent(source, {
        paused: Boolean(item.paused),
        path: item.path || config.downloadPath,
        restoring: true
      })
    } catch (err) {
      console.error('restore failed', source, err)
    }
  }
}

async function removeEntry (id, deleteFiles) {
  const entry = entries.get(id)
  if (!entry) return

  entries.delete(id)
  const savedTorrentPath = entry.savedTorrentPath
  const torrent = entry.torrent
  const infoHash = torrent.infoHash

  if (!torrent.destroyed) {
    try {
      await client.remove(torrent, { destroyStore: deleteFiles })
    } catch (err) {
      console.error('remove failed', err)
    }
  }

  for (const leftover of [savedTorrentPath, infoHash && posterFile(infoHash)]) {
    if (!leftover) continue
    try {
      await fsp.unlink(leftover)
    } catch {}
  }

  saveSession()
  pushUpdate()
  return true
}

// WebTorrent gives paths relative to the torrent's download folder.
function firstFilePath (entry) {
  const files = entry?.torrent?.files || []
  const file = files.find((item) => item?.path) || null
  if (!file) return null
  return path.join(entry.torrent.path || entry.downloadPath, file.path)
}

function entryByInfoHash (infoHash) {
  for (const entry of entries.values()) {
    if (entry.torrent?.infoHash === infoHash) return entry
  }
  return null
}

function findFile (infoHash, index) {
  const torrent = entryByInfoHash(infoHash)?.torrent
  if (!torrent || torrent.destroyed) return null
  return torrent.files?.[index] || null
}

function posterFile (infoHash) {
  return path.join(postersDir, `${infoHash}.jpg`)
}

async function playInVlc (entry) {
  const torrent = entry?.torrent
  const index = entry?.playIndex ?? -1
  const file = index >= 0 ? torrent?.files?.[index] : null
  if (!file) return { ok: false, error: 'No video or audio file in this torrent.' }

  const vlc = await findVlc()
  if (!vlc) return { ok: false, error: 'VLC is not installed. It is free at videolan.org.' }

  const onDisk = path.join(torrent.path || entry.downloadPath, file.path)
  let target = onDisk
  if (!file.done || !fs.existsSync(onDisk)) {
    // Not finished yet: VLC streams it, pieces are fetched in playback order.
    if (torrent.paused) torrent.resume()
    target = await streamServer.urlFor(torrent.infoHash, index, file.name)
  }

  launchVlc(vlc, target, file.name)
  return { ok: true }
}

function listTorrents () {
  return Array.from(entries.values()).map(serializeEntry)
}

function serializeEntry (entry) {
  const torrent = entry.torrent
  const files = torrent.files || []
  const ratio = torrent.ratio
  const infoHash = torrent.infoHash || null

  // Poster already captured in an earlier session?
  if (entry.posterVersion === undefined && infoHash) {
    entry.posterVersion = fs.existsSync(posterFile(infoHash)) ? 1 : 0
  }

  const preview = entry.preview
  const previewUrl = preview && infoHash ? `${MEDIA_SCHEME}://media/${infoHash}/${preview.index}` : null

  return {
    id: entry.id,
    name: torrent.name || 'Fetching metadata…',
    infoHash,
    progress: clamp01(torrent.progress || 0),
    downloadSpeed: torrent.downloadSpeed || 0,
    uploadSpeed: torrent.uploadSpeed || 0,
    downloaded: torrent.downloaded || 0,
    uploaded: torrent.uploaded || 0,
    length: torrent.length || 0,
    ratio: Number.isFinite(ratio) ? ratio : 0,
    numPeers: torrent.numPeers || 0,
    paused: Boolean(torrent.paused),
    done: Boolean(torrent.done),
    ready: Boolean(torrent.ready),
    error: entry.error || null,
    filesCount: files.length,
    downloadPath: entry.downloadPath,
    playable: entry.playIndex >= 0,
    previewUrl,
    previewKind: preview?.kind || null,
    needsPoster: Boolean(previewUrl && !entry.posterVersion && !entry.posterFailed && !torrent.paused),
    posterUrl: entry.posterVersion ? `${MEDIA_SCHEME}://poster/${infoHash}?v=${entry.posterVersion}` : null
  }
}

function clamp01 (value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function pushUpdate () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible() && !smokeTest) return
  mainWindow.webContents.send('torrents:update', listTorrents())
}

function notifySound (name) {
  if (!config?.soundNotifications || isQuitting || !mainWindow || mainWindow.isDestroyed()) return
  if (!soundsReady) {
    if (pendingSounds.length < 16) pendingSounds.push(name)
    return
  }
  mainWindow.webContents.send('sounds:play', name)
}

function reportError (err) {
  const message = String(err?.message || err || 'Unknown error')
  console.error(message)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:error', message)
  }
}

function showWindow () {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function pickTorrentFiles () {
  if (!mainWindow) return
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Torrent',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Torrents', extensions: ['torrent'] }]
  })
  if (result.canceled) return
  for (const filePath of result.filePaths) {
    try {
      await handleTorrentFile(filePath)
    } catch (err) {
      reportError(err)
    }
  }
}

// Closes every connection (WebRTC included) so the process can exit.
async function stopEngine () {
  if (engineStopped) return
  if (updateTimer) clearInterval(updateTimer)
  streamServer?.close()
  if (client && !client.destroyed) {
    await Promise.race([
      new Promise((resolve) => client.destroy(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ])
  }
  engineStopped = true
}

function runSmokeTest () {
  const finish = (code) => {
    stopEngine().finally(() => app.exit(code))
  }
  const fail = (reason) => {
    console.error(`SMOKE FAIL ${reason}`)
    finish(1)
  }
  // An exception must end the check launch, not open an error dialog nobody closes.
  process.on('uncaughtException', (err) => fail(`uncaught ${err?.stack || err}`))
  const timer = setTimeout(() => fail('timed out'), 90000)

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const page = await mainWindow.webContents.executeJavaScript(`(async () => {
        const logo = document.querySelector('.logo')
        if (logo && !logo.complete) await new Promise((resolve) => logo.addEventListener('load', resolve, { once: true }))
        return {
          bridge: typeof window.api?.list,
          torrents: await window.api.list().then((list) => list.length),
          script: typeof render,
          styles: getComputedStyle(document.body).backgroundColor,
          logo: logo ? logo.naturalWidth : 0
        }
      })()`)
      if (page.bridge !== 'function') return fail(`renderer bridge missing (${page.bridge})`)
      if (page.script !== 'function') return fail('app.js not loaded')
      if (page.styles !== 'rgb(15, 17, 21)') return fail(`styles.css not loaded (${page.styles})`)
      if (!(page.logo > 0)) return fail('logo not loaded')
      if (!WEBRTC_SUPPORT) return fail('WebRTC unavailable')
      if (!client || client.destroyed) return fail('engine stopped')

      const soundAssets = await smokeSounds()

      // Full poster path on a real video: protocol, range requests, frame
      // capture in the window, IPC, file on disk.
      let poster = 'skipped'
      if (smokeVideo) poster = await smokePoster(smokeVideo)

      clearTimeout(timer)
      console.log(`SMOKE OK webrtc=${WEBRTC_SUPPORT} poster=${poster} sounds=${soundAssets} electron=${process.versions.electron}`)
      finish(0)
    } catch (err) {
      fail(String(err?.message || err))
    }
  })
}

async function smokeSounds () {
  const count = await mainWindow.webContents.executeJavaScript(`(async () => {
    const button = document.getElementById('toggle-sounds')
    const waitForSetting = async () => {
      const started = Date.now()
      while (button.disabled) {
        if (Date.now() - started > 5000) throw new Error('sound setting timed out')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    await waitForSetting()
    const names = ['startup', 'add', 'delete', 'disable', 'enable', 'done', 'error', 'play']
    for (const name of names) {
      const audio = new Audio(new URL('sounds/' + name + '.wav', document.baseURI).href)
      audio.volume = SOUND_VOLUMES[name]
      await audio.play()
      if (!(audio.duration > 0)) throw new Error('sound not decoded: ' + name)
      audio.pause()
    }
    window.__smokeSoundEvents = []
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      const name = this.src.split('/').at(-1)?.replace('.wav', '')
      if (Object.hasOwn(SOUND_VOLUMES, name)) window.__smokeSoundEvents.push(name)
      return original.apply(this, args)
    }
    await window.api.soundsReady()
    if (window.__smokeSoundEvents.length) throw new Error('startup sound repeated')
    button.click()
    await waitForSetting()
    if ((await window.api.settings()).soundNotifications !== false) throw new Error('mute IPC failed')
    return names.length
  })()`)
  if (JSON.parse(fs.readFileSync(configFile, 'utf8')).soundNotifications !== false) {
    throw new Error('mute not saved to disk')
  }
  loadConfig()
  if (config.soundNotifications !== false) throw new Error('saved mute not restored')
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const button = document.getElementById('toggle-sounds')
    button.click()
    while (button.disabled) await new Promise(resolve => setTimeout(resolve, 20))
    if ((await window.api.settings()).soundNotifications !== true) throw new Error('unmute IPC failed')
  })()`)
  return count
}

async function smokePoster (videoPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtorrent2-smoke-media-'))
  const copy = path.join(dir, path.basename(videoPath))
  fs.copyFileSync(videoPath, copy)

  const seeded = await new Promise((resolve) => client.seed(copy, { announce: [] }, resolve))
  const torrentFile = Buffer.from(seeded.torrentFile)
  await new Promise((resolve) => client.remove(seeded, { destroyStore: false }, resolve))

  const entry = await addTorrent(torrentFile, { path: dir, restoring: true })
  if (!entry) throw new Error('smoke torrent not added')

  const started = Date.now()
  while (Date.now() - started < 60000) {
    if (entry.posterVersion > 0) {
      const size = fs.statSync(posterFile(entry.torrent.infoHash)).size
      await smokeSoundActions(entry, torrentFile, dir)
      return `${size}B`
    }
    if (entry.posterFailed) throw new Error('poster capture failed in the window')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('poster not captured within 60 s')
}

async function smokeSoundActions (entry, torrentFile, dir) {
  // Restoring verified files and generating their poster must stay silent.
  mainWindow.hide()
  showWindow()
  const events = await mainWindow.webContents.executeJavaScript(`(async () => {
    if (window.__smokeSoundEvents.length) throw new Error('restored torrent or preview played a sound')
    await window.api.pause(${entry.id})
    await window.api.pause(${entry.id})
    await window.api.resume(${entry.id})
    await window.api.resume(${entry.id})
    await window.api.remove(${entry.id}, false)
    return window.__smokeSoundEvents.slice()
  })()`)
  if (JSON.stringify(events) !== JSON.stringify(['disable', 'enable', 'delete'])) {
    throw new Error(`wrong action sounds: ${JSON.stringify(events)}`)
  }
  const added = await addTorrent(torrentFile, { path: dir })
  if (!added.torrent.done) await new Promise(resolve => added.torrent.once('done', resolve))
  const afterAdd = await mainWindow.webContents.executeJavaScript('window.__smokeSoundEvents.slice()')
  if (JSON.stringify(afterAdd) !== JSON.stringify(['disable', 'enable', 'delete', 'add'])) {
    throw new Error(`adding existing files replayed completion: ${JSON.stringify(afterAdd)}`)
  }
}
