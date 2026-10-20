const bridge = window.api

const els = {
  downloadPath: document.getElementById('download-path'),
  statDown: document.getElementById('stat-down'),
  statUp: document.getElementById('stat-up'),
  statCount: document.getElementById('stat-count'),
  addFile: document.getElementById('add-file'),
  chooseFolder: document.getElementById('choose-folder'),
  openFolder: document.getElementById('open-folder'),
  magnet: document.getElementById('magnet-input'),
  paste: document.getElementById('paste-btn'),
  addMagnet: document.getElementById('add-magnet'),
  dropOverlay: document.getElementById('drop-overlay'),
  listCount: document.getElementById('list-count'),
  list: document.getElementById('torrent-list'),
  empty: document.getElementById('empty-state'),
  modal: document.getElementById('modal'),
  modalName: document.getElementById('modal-name'),
  modalCancel: document.getElementById('modal-cancel'),
  modalKeep: document.getElementById('modal-keep'),
  modalDelete: document.getElementById('modal-delete'),
  toast: document.getElementById('toast')
}

let torrents = []
let removeTarget = null
let toastTimer = null
let dragTimer = null

// One persistent <li> per torrent: only its text is redrawn every second, so the
// poster in the background and a running hover preview never flicker.
const rows = new Map()

init().catch((err) => {
  toast(String(err?.message || err), true)
})

async function init () {
  bind()

  bridge.onUpdate((list) => {
    torrents = Array.isArray(list) ? list : []
    render()
  })

  bridge.onError((message) => toast(message, true))

  bridge.onFocus((id) => {
    render()
    const row = rows.get(Number(id))?.li
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
      row.classList.add('flash')
      setTimeout(() => row.classList.remove('flash'), 1200)
    }
  })

  try {
    const settings = await bridge.settings()
    els.downloadPath.textContent = settings.downloadPath
    els.downloadPath.title = settings.downloadPath
  } catch {}

  try {
    torrents = await bridge.list()
  } catch {}

  render()
}

function bind () {
  els.addFile.addEventListener('click', addFiles)
  els.chooseFolder.addEventListener('click', chooseFolder)
  els.openFolder.addEventListener('click', openFolder)
  els.addMagnet.addEventListener('click', submitMagnet)
  els.paste.addEventListener('click', pasteFromClipboard)

  els.magnet.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitMagnet()
  })

  els.list.addEventListener('click', onListClick)

  // Drag and drop on the whole window. preventDefault everywhere: a dropped
  // file never opens a page, it is either added or ignored.
  window.addEventListener('dragenter', (event) => {
    event.preventDefault()
    if (isDropCandidate(event)) showDropOverlay()
  })

  window.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (isDropCandidate(event)) {
      event.dataTransfer.dropEffect = 'copy'
      showDropOverlay()
    }
  })

  els.dropOverlay.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) hideDropOverlay()
  })

  window.addEventListener('drop', (event) => {
    event.preventDefault()
    hideDropOverlay()
    handleDrop(event)
  })

  els.modalCancel.addEventListener('click', closeModal)
  els.modalKeep.addEventListener('click', () => confirmRemove(false))
  els.modalDelete.addEventListener('click', () => confirmRemove(true))

  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeModal()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modal.hidden) closeModal()
  })
}

async function addFiles () {
  try {
    const result = await bridge.pickFiles()
    if (result?.added > 0) toast(`${plural(result.added, 'torrent')} added`)
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

async function chooseFolder () {
  try {
    const result = await bridge.chooseDownload()
    if (result?.ok) {
      els.downloadPath.textContent = result.downloadPath
      els.downloadPath.title = result.downloadPath
      toast('Download folder updated. It applies to torrents you add from now on.')
    } else if (result?.error) {
      toast(result.error, true)
    }
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

async function openFolder () {
  try {
    const result = await bridge.openFolder()
    if (result && result.ok === false) toast(result.error || 'Could not open the folder.', true)
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

async function pasteFromClipboard () {
  try {
    const text = String(await bridge.readClipboard()).trim()
    if (!text) {
      toast('The clipboard is empty.')
      return
    }
    els.magnet.value = text
    els.magnet.focus()
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

async function submitMagnet () {
  const value = els.magnet.value.trim()
  if (!value) return

  try {
    const result = await bridge.addText(value)
    if (result?.ok) {
      els.magnet.value = ''
      toast('Torrent added.')
    } else {
      toast(result?.error || 'Could not add this torrent.', true)
    }
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

function isDropCandidate (event) {
  const types = Array.from(event.dataTransfer?.types || [])
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')
}

function showDropOverlay () {
  els.dropOverlay.hidden = false
  document.body.classList.add('dragging')
  // Safety net: no dragover for a second means the drag is over
  // (Escape, or leaving the window without a dragleave).
  clearTimeout(dragTimer)
  dragTimer = setTimeout(hideDropOverlay, 1000)
}

function hideDropOverlay () {
  clearTimeout(dragTimer)
  els.dropOverlay.hidden = true
  document.body.classList.remove('dragging')
}

function droppedMagnets (dataTransfer) {
  const text = [dataTransfer?.getData('text/uri-list'), dataTransfer?.getData('text/plain')]
    .filter(Boolean)
    .join('\n')
  return Array.from(new Set(text.split(/\s+/).filter((value) => /^magnet:\?/i.test(value))))
}

async function handleDrop (event) {
  const files = Array.from(event.dataTransfer?.files || [])
  const magnets = droppedMagnets(event.dataTransfer)
  let added = 0
  let ignored = 0

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.torrent')) {
      ignored += 1
      continue
    }
    try {
      const filePath = bridge.pathForFile(file)
      if (!filePath) continue
      const result = await bridge.addPath(filePath)
      if (result?.ok) added += 1
      else if (result?.error) toast(result.error, true)
    } catch (err) {
      toast(String(err?.message || err), true)
    }
  }

  for (const magnet of magnets) {
    try {
      const result = await bridge.addText(magnet)
      if (result?.ok) added += 1
      else if (result?.error) toast(result.error, true)
    } catch (err) {
      toast(String(err?.message || err), true)
    }
  }

  if (added > 0) {
    toast(`${plural(added, 'torrent')} added`)
  } else if (ignored > 0 || (files.length === 0 && magnets.length === 0)) {
    toast('Nothing to add: drop a .torrent file or a magnet link.', true)
  }
}

async function onListClick (event) {
  const button = event.target.closest('button[data-action]')
  if (!button) return

  const row = button.closest('li[data-id]')
  if (!row) return

  const id = Number(row.dataset.id)
  const torrent = torrents.find((item) => item.id === id)
  if (!torrent) return

  const action = button.dataset.action

  try {
    if (action === 'toggle') {
      if (torrent.paused) await bridge.resume(id)
      else await bridge.pause(id)
    } else if (action === 'reveal') {
      await bridge.reveal(id)
    } else if (action === 'play') {
      const result = await bridge.play(id)
      if (result && result.ok === false) toast(result.error || 'Could not start VLC.', true)
    } else if (action === 'open') {
      const result = await bridge.openFile(id)
      if (result && result.ok === false) toast(result.error || 'Could not open the file.', true)
    } else if (action === 'remove') {
      openRemoveModal(torrent)
    }
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

function openRemoveModal (torrent) {
  removeTarget = torrent
  els.modalName.textContent = torrent.name
  els.modal.hidden = false
}

function closeModal () {
  removeTarget = null
  els.modal.hidden = true
}

async function confirmRemove (deleteFiles) {
  const target = removeTarget
  closeModal()
  if (!target) return

  try {
    await bridge.remove(target.id, deleteFiles)
    toast(deleteFiles ? 'Torrent removed and files deleted.' : 'Torrent removed, files kept.')
  } catch (err) {
    toast(String(err?.message || err), true)
  }
}

function render () {
  const list = torrents
  const seen = new Set()
  let previous = null

  for (const torrent of list) {
    seen.add(torrent.id)
    const row = rowFor(torrent)
    row.torrent = torrent

    const html = rowHtml(torrent)
    if (html !== row.html) {
      row.html = html
      row.body.innerHTML = html
      // Width set through CSSOM: the CSP does not need to allow inline styles.
      for (const bar of row.body.querySelectorAll('.bar-fill')) {
        bar.style.width = `${bar.dataset.progress}%`
      }
    }

    row.li.classList.toggle('has-error', Boolean(torrent.error))
    setPoster(row, torrent.posterUrl)
    if (torrent.paused) stopLivePreview(row)

    const expected = previous ? previous.nextSibling : els.list.firstChild
    if (expected !== row.li) els.list.insertBefore(row.li, expected)
    previous = row.li
  }

  for (const [id, row] of rows) {
    if (seen.has(id)) continue
    stopLivePreview(row)
    row.li.remove()
    rows.delete(id)
  }

  els.empty.hidden = list.length > 0
  els.listCount.textContent = list.length === 0 ? 'No torrents' : plural(list.length, 'torrent')

  const down = list.reduce((sum, item) => sum + (item.downloadSpeed || 0), 0)
  const up = list.reduce((sum, item) => sum + (item.uploadSpeed || 0), 0)

  els.statDown.textContent = `↓ ${formatSpeed(down)}`
  els.statUp.textContent = `↑ ${formatSpeed(up)}`
  els.statCount.textContent = plural(list.length, 'torrent')

  schedulePosters()
}

function rowFor (torrent) {
  let row = rows.get(torrent.id)
  if (row) return row

  const li = document.createElement('li')
  li.className = 'torrent'
  li.dataset.id = String(torrent.id)

  const media = document.createElement('div')
  media.className = 'torrent-media'
  media.setAttribute('aria-hidden', 'true')

  const body = document.createElement('div')
  body.className = 'torrent-body'

  li.append(media, body)
  row = { li, media, body, html: '', poster: null, video: null, torrent }
  rows.set(torrent.id, row)

  li.addEventListener('mouseenter', () => startLivePreview(row))
  li.addEventListener('mouseleave', () => stopLivePreview(row))
  return row
}

function setPoster (row, url) {
  if (row.poster === url) return
  row.poster = url
  row.li.classList.toggle('has-poster', Boolean(url))
  if (url) row.li.style.setProperty('--poster', `url("${url}")`)
  else row.li.style.removeProperty('--poster')
}

function rowHtml (torrent) {
  const progress = torrent.done ? 1 : torrent.progress || 0
  const width = (progress * 100).toFixed(2)
  const percent = formatNumber(progress * 100, progress > 0 && progress < 1 ? 1 : 0)
  const state = statusOf(torrent)
  const eta = etaOf(torrent)
  const ratio = formatNumber(torrent.ratio || 0, 2)

  return `
      <div class="torrent-top">
        <div class="torrent-name" title="${escapeHtml(torrent.name)}">${escapeHtml(torrent.name)}</div>
        <span class="pill pill--${state.key}">${state.label}</span>
      </div>
      <div class="bar">
        <span class="bar-fill bar-fill--${state.key}" data-progress="${width}"></span>
      </div>
      <div class="torrent-meta">
        <span>${percent}%</span>
        <span>${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)}</span>
        <span class="down">↓ ${formatSpeed(torrent.downloadSpeed)}</span>
        <span class="up">↑ ${formatSpeed(torrent.uploadSpeed)}</span>
        <span>${plural(torrent.numPeers, 'peer')}</span>
        <span>ratio ${ratio}</span>
        ${eta ? `<span>${eta}</span>` : ''}
        ${torrent.filesCount > 1 ? `<span>${plural(torrent.filesCount, 'file')}</span>` : ''}
        ${torrent.error ? `<span class="error">${escapeHtml(torrent.error)}</span>` : ''}
      </div>
      <div class="torrent-actions">
        <button class="ghost small" data-action="toggle">${torrent.paused ? 'Resume' : 'Pause'}</button>
        ${torrent.playable ? `<button class="ghost small play" data-action="play" ${torrent.ready ? '' : 'disabled'}>Play in VLC</button>` : ''}
        <button class="ghost small" data-action="open" ${torrent.done ? '' : 'disabled'}>Open</button>
        <button class="ghost small" data-action="reveal">Show in Finder</button>
        <button class="ghost small danger" data-action="remove">Remove</button>
      </div>
  `
}

function statusOf (torrent) {
  if (torrent.error) return { key: 'error', label: 'Error' }
  if (torrent.paused) return { key: 'paused', label: 'Paused' }
  if (!torrent.ready) return { key: 'meta', label: 'Metadata' }
  if (torrent.done) return { key: 'seed', label: 'Seeding' }
  return { key: 'down', label: 'Downloading' }
}

function etaOf (torrent) {
  if (torrent.done || torrent.paused || !torrent.downloadSpeed || !torrent.length) return ''
  const remaining = torrent.length - torrent.downloaded
  if (remaining <= 0) return ''
  const seconds = remaining / torrent.downloadSpeed
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return `${formatDuration(seconds)} left`
}

// --- Card backgrounds --------------------------------------------------------
// WebTorrent Desktop grabbed one frame at 3% of the video (60 s max), which
// often lands on a black screen or a studio logo. Here three moments are tried
// and the most readable frame wins. Shipped artwork (poster.jpg, cover.png) is
// used as is, re-encoded small.

const POSTER_WIDTH = 640
const FRAME_MOMENTS = [0.15, 0.35, 0.55]
const posterTried = new Set()
let posterBusy = false

function schedulePosters () {
  if (posterBusy) return
  const next = torrents.find((torrent) => torrent.needsPoster && !posterTried.has(torrent.infoHash))
  if (!next) return

  posterTried.add(next.infoHash)
  posterBusy = true
  const capture = next.previewKind === 'image' ? captureImage(next.previewUrl) : captureVideo(next.previewUrl)
  capture
    .then((bytes) => bridge.savePoster(next.id, bytes))
    .catch((err) => {
      console.warn('poster failed', next.name, err?.message || err)
      return bridge.posterFailed(next.id)
    })
    .catch(() => {})
    .finally(() => {
      posterBusy = false
      schedulePosters()
    })
}

function withTimeout (promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

function once (target, name) {
  return new Promise((resolve, reject) => {
    const onEvent = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error(`media error on ${name}`)) }
    const cleanup = () => {
      target.removeEventListener(name, onEvent)
      target.removeEventListener('error', onError)
    }
    target.addEventListener(name, onEvent)
    target.addEventListener('error', onError)
  })
}

async function captureVideo (url) {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  try {
    const loaded = once(video, 'loadedmetadata')
    video.src = url
    // Pieces are fetched on demand: a slow swarm can take a while.
    await withTimeout(loaded, 120000, 'metadata')

    let best = null
    for (const moment of FRAME_MOMENTS) {
      const seeked = once(video, 'seeked')
      video.currentTime = momentOf(video.duration, moment)
      await withTimeout(seeked, 120000, 'seek')
      const canvas = drawFrame(video, video.videoWidth, video.videoHeight)
      const score = frameScore(canvas)
      if (!best || score > best.score) best = { canvas, score }
      if (score >= 60) break // clearly good: no need to fetch more pieces
    }
    if (!best) throw new Error('no frame')
    return await toJpeg(best.canvas)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

async function captureImage (url) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await withTimeout(image.decode(), 120000, 'image')
  return toJpeg(drawFrame(image, image.naturalWidth, image.naturalHeight))
}

function momentOf (duration, fraction) {
  if (!Number.isFinite(duration) || duration <= 0) return 10 * (1 + fraction * 10)
  return Math.min(duration * fraction, 1800)
}

function drawFrame (source, width, height) {
  if (!width || !height) throw new Error('no picture')
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(POSTER_WIDTH, width)
  canvas.height = Math.round(canvas.width * height / width)
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

// Readability score: contrast and color, heavy penalty for near black or
// near white frames (fades, title cards).
function frameScore (canvas) {
  const sample = document.createElement('canvas')
  sample.width = 48
  sample.height = 27
  const context = sample.getContext('2d', { willReadFrequently: true })
  context.drawImage(canvas, 0, 0, sample.width, sample.height)
  const { data } = context.getImageData(0, 0, sample.width, sample.height)

  let sum = 0
  let sumSquares = 0
  let chroma = 0
  const count = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    sum += luma
    sumSquares += luma * luma
    chroma += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
  }
  const mean = sum / count
  const contrast = Math.sqrt(Math.max(0, sumSquares / count - mean * mean))
  const color = chroma / count
  const exposure = mean < 30 || mean > 225 ? -100 : 0
  return contrast + color * 0.5 + exposure
}

async function toJpeg (canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
  if (!blob) throw new Error('encoding failed')
  return new Uint8Array(await blob.arrayBuffer())
}

// Hovering a video card plays it muted in the background, from the same part of
// the film as the poster. Stopped when the pointer leaves or the torrent pauses.
function startLivePreview (row) {
  const torrent = row.torrent
  if (row.video || torrent.previewKind !== 'video' || !torrent.previewUrl || torrent.paused) return

  const video = document.createElement('video')
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = momentOf(video.duration, FRAME_MOMENTS[0])
    video.play().catch(() => {})
  }, { once: true })
  video.addEventListener('playing', () => row.li.classList.add('live'), { once: true })
  video.addEventListener('error', () => stopLivePreview(row), { once: true })
  video.src = torrent.previewUrl

  row.video = video
  row.media.append(video)
}

function stopLivePreview (row) {
  if (!row.video) return
  row.li.classList.remove('live')
  row.video.pause()
  row.video.removeAttribute('src')
  row.video.load()
  row.video.remove()
  row.video = null
}

// --- Formatting --------------------------------------------------------------

function plural (count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function formatBytes (value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const digits = index === 0 ? 0 : size >= 10 ? 0 : 1
  return `${formatNumber(size, digits)} ${units[index]}`
}

function formatSpeed (value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s'
  return `${formatBytes(value)}/s`
}

function formatDuration (seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  return `${formatNumber(seconds / 3600, 1)} h`
}

function formatNumber (value, digits) {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(digits)
}

function escapeHtml (value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}

function toast (message, isError = false) {
  els.toast.textContent = message
  els.toast.classList.toggle('toast--error', Boolean(isError))
  els.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    els.toast.hidden = true
  }, 4200)
}
