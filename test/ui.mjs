import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'

const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const renderer = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8')

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'file:///app/index.html',
  pretendToBeVisual: true
})

const { window } = dom
const calls = []
const audioPlays = []
const audioInstances = []
let soundPreference = true
let soundHandshake = false
let emitUpdate = null
let emitError = null
let emitSound = null

window.Audio = class {
  constructor (src) {
    this.src = src
    this.currentTime = 0
    this.paused = true
    audioInstances.push(this)
  }

  async play () {
    this.paused = false
    audioPlays.push({ src: this.src, volume: this.volume, currentTime: this.currentTime })
  }

  pause () { this.paused = true }
}

const sample = {
  id: 1,
  name: 'Test <torrent>',
  infoHash: 'a'.repeat(40),
  progress: 0.5,
  downloadSpeed: 1048576,
  uploadSpeed: 2048,
  downloaded: 500,
  length: 1000,
  ratio: 0.4,
  numPeers: 3,
  paused: false,
  done: false,
  ready: true,
  error: null,
  filesCount: 1,
  playable: true,
  previewUrl: null,
  previewKind: null,
  needsPoster: false,
  posterUrl: null
}

window.api = {
  list: async () => [sample],
  settings: async () => ({ downloadPath: '/Users/test/Downloads', soundNotifications: soundPreference, version: '0.2.1' }),
  setSounds: async (enabled) => { soundPreference = enabled; return { soundNotifications: enabled } },
  soundsReady: async () => {
    if (!soundHandshake) {
      soundHandshake = true
      emitSound('startup')
    }
  },
  onSound: (callback) => { emitSound = callback; return () => {} },
  onUpdate: (callback) => {
    emitUpdate = callback
    return () => {}
  },
  onFocus: () => () => {},
  onError: (callback) => {
    emitError = callback
    return () => {}
  },
  pause: async (id) => { calls.push(['pause', id]) },
  resume: async (id) => { calls.push(['resume', id]) },
  remove: async (id, deleteFiles) => { calls.push(['remove', id, deleteFiles]) },
  reveal: async (id) => { calls.push(['reveal', id]) },
  play: async (id) => { calls.push(['play', id]); return { ok: false, error: 'VLC is not installed. It is free at videolan.org.' } },
  openFile: async (id) => { calls.push(['open', id]); return { ok: true } },
  addText: async (text) => { calls.push(['addText', text]); return { ok: true } },
  addPath: async (filePath) => { calls.push(['addPath', filePath]); return { ok: true } },
  savePoster: async (id, bytes) => { calls.push(['savePoster', id, bytes]); return { ok: true } },
  posterFailed: async (id) => { calls.push(['posterFailed', id]); return { ok: true } },
  pickFiles: async () => ({ ok: true, added: 0 }),
  chooseDownload: async () => ({ ok: false }),
  openFolder: async () => ({ ok: true }),
  readClipboard: async () => 'magnet:?xt=urn:btih:deadbeef',
  pathForFile: () => null
}

window.eval(renderer)
await tick(100)

const document = window.document
const rows = document.querySelectorAll('li.torrent')
assert.equal(rows.length, 1, 'one torrent row')
assert.equal(document.querySelector('.torrent-name').textContent, 'Test <torrent>', 'name shown')
assert.match(document.querySelector('.torrent-name').innerHTML, /&lt;torrent&gt;/, 'name escaped')
assert.equal(document.querySelector('.pill').textContent, 'Downloading', 'downloading state')
assert.match(document.querySelector('.bar-fill').getAttribute('style'), /width:\s*50(\.00)?%/, 'progress at 50%')
assert.equal(document.getElementById('list-count').textContent, '1 torrent')
assert.match(document.getElementById('stat-down').textContent, /1\.0 MB\/s/, 'download speed formatted')
assert.match(document.getElementById('stat-up').textContent, /2\.0 KB\/s/, 'upload speed formatted')
assert.equal(document.getElementById('download-path').textContent, '/Users/test/Downloads')
assert.equal(document.querySelector('[data-action="reveal"]').textContent, 'Show in Finder')
assert.equal(document.querySelector('[data-action="play"]').textContent, 'Play in VLC')
console.log('first render: ok')

assert.deepEqual(audioPlays, [{ src: 'file:///app/sounds/startup.wav', volume: 0.25, currentTime: 0 }], 'one startup sound after settings are loaded')
for (const [name, volume] of Object.entries({ add: 0.25, delete: 0.125, disable: 0.125, enable: 0.125, done: 0.25, error: 0.25, play: 0.25 })) {
  emitSound(name)
  assert.deepEqual(audioPlays.at(-1), { src: `file:///app/sounds/${name}.wav`, volume, currentTime: 0 }, `${name} uses the original asset and volume`)
}
const instancesBeforeReplay = audioInstances.length
audioInstances.find((audio) => audio.src.endsWith('/add.wav')).currentTime = 0.3
emitSound('add')
assert.equal(audioInstances.length, instancesBeforeReplay, 'sound elements are reused')
assert.equal(audioPlays.at(-1).currentTime, 0, 'repeated sound starts at the beginning')
const playsBeforeUnknown = audioPlays.length
emitSound('../untrusted')
emitSound('toString')
assert.equal(audioPlays.length, playsBeforeUnknown, 'unknown sound names cannot load files')

const soundButton = document.getElementById('toggle-sounds')
soundButton.click()
assert.equal(soundButton.getAttribute('aria-pressed'), 'false', 'mute takes effect immediately')
assert.ok(audioInstances.every((audio) => audio.paused), 'muting stops currently playing sounds')
await tick(20)
assert.equal(soundPreference, false, 'mute is saved through the bridge')
emitSound('done')
emitError('silent error')
assert.equal(audioPlays.length, playsBeforeUnknown, 'completion and error sounds respect mute')

// A fresh renderer reads the saved preference before accepting sound events.
const mutedDom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///app/index.html' })
const originalCallbacks = { update: emitUpdate, error: emitError, sound: emitSound }
mutedDom.window.Audio = window.Audio
mutedDom.window.api = { ...window.api, soundsReady: async () => emitSound('startup') }
mutedDom.window.eval(renderer)
await tick(20)
assert.equal(mutedDom.window.document.getElementById('toggle-sounds').getAttribute('aria-pressed'), 'false', 'saved mute survives renderer startup')
emitSound('add')
assert.equal(audioPlays.length, playsBeforeUnknown, 'muted startup remains silent')
mutedDom.window.close()
// Restore the original renderer's event callbacks after testing the fresh one.
emitSound = originalCallbacks.sound
emitUpdate = originalCallbacks.update
emitError = originalCallbacks.error
soundButton.click()
await tick(20)
assert.equal(soundPreference, true, 'sounds can be enabled again')
assert.equal(audioPlays.length, playsBeforeUnknown, 'changing the setting does not play a sound')
console.log('original sound levels, mute and saved preference: ok')

const firstRow = document.querySelector('li.torrent')
document.querySelector('[data-action="toggle"]').click()
await tick(20)
assert.deepEqual(calls.at(-1), ['pause', 1], 'pause called with the right id')
console.log('pause: ok')

document.querySelector('[data-action="play"]').click()
await tick(20)
assert.deepEqual(calls.at(-1), ['play', 1], 'play in VLC called')
assert.equal(document.getElementById('toast').textContent, 'VLC is not installed. It is free at videolan.org.', 'missing VLC explained')
console.log('play in VLC: ok')

const posterUrl = `webtorrent2://poster/${'a'.repeat(40)}?v=1`
emitUpdate([{ ...sample, progress: 1, done: true, downloadSpeed: 0, posterUrl }])
await tick(20)
assert.equal(document.querySelector('li.torrent'), firstRow, 'the row element is kept between updates')
assert.equal(document.querySelector('.pill').textContent, 'Seeding', 'seeding state')
assert.equal(document.querySelector('[data-action="open"]').disabled, false, 'open available')
assert.ok(firstRow.classList.contains('has-poster'), 'poster shown as background')
assert.match(firstRow.style.getPropertyValue('--poster'), /webtorrent2:\/\/poster\//, 'poster URL set through CSSOM')
console.log('seeding with poster: ok')

emitUpdate([{ ...sample, playable: false, posterUrl: null }])
await tick(20)
assert.equal(document.querySelector('[data-action="play"]'), null, 'no VLC button without media')
assert.ok(!firstRow.classList.contains('has-poster'), 'poster removed')
console.log('non-media torrent: ok')

document.querySelector('[data-action="remove"]').click()
await tick(20)
assert.equal(document.getElementById('modal').hidden, false, 'modal open')
assert.equal(document.getElementById('modal-name').textContent, 'Test <torrent>', 'name in the modal')
document.getElementById('modal-delete').click()
await tick(20)
assert.deepEqual(calls.at(-1), ['remove', 1, true], 'file deletion requested')
assert.equal(document.getElementById('modal').hidden, true, 'modal closed')
console.log('remove: ok')

function pasteEvent (text) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  return event
}

document.body.dispatchEvent(pasteEvent('magnet:?xt=urn:btih:cafebabe'))
await tick(20)
assert.deepEqual(calls.at(-1), ['addText', 'magnet:?xt=urn:btih:cafebabe'], 'pasted magnet added without an input field')
const callsBeforeText = calls.length
document.body.dispatchEvent(pasteEvent('ordinary clipboard text'))
await tick(20)
assert.equal(calls.length, callsBeforeText, 'ordinary text does not create a torrent')
console.log('paste magnet without an input field: ok')

const soundsBeforeError = audioPlays.length
emitError('test error')
await tick(20)
assert.equal(document.getElementById('toast').hidden, false, 'toast visible')
assert.equal(document.getElementById('toast').textContent, 'test error')
assert.ok(document.getElementById('toast').classList.contains('toast--error'), 'error toast')
assert.equal(audioPlays.length, soundsBeforeError + 1, 'one sound per reported error')
assert.equal(audioPlays.at(-1).src, 'file:///app/sounds/error.wav')
console.log('toast: ok')

// Drag and drop: anywhere in the window, title bar included.
function dragEvent (type, data) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return event
}

const overlay = document.getElementById('drop-overlay')
const titlebar = document.querySelector('.window-drag-region')
const fileDrag = { types: ['Files'], files: [{ name: 'Movie.TORRENT' }, { name: 'notes.txt' }], dropEffect: 'none', getData: () => '' }

titlebar.dispatchEvent(dragEvent('dragenter', fileDrag))
assert.equal(overlay.hidden, false, 'drop zone shown as soon as the drag enters through the title bar')
assert.ok(document.body.classList.contains('dragging'), 'title bar released while dragging')

window.api.pathForFile = (file) => `/Users/test/Downloads/${file.name}`
const dropOnTitle = dragEvent('drop', fileDrag)
titlebar.dispatchEvent(dropOnTitle)
await tick(20)
assert.equal(dropOnTitle.defaultPrevented, true, 'the browser never opens the dropped file')
assert.deepEqual(calls.at(-1), ['addPath', '/Users/test/Downloads/Movie.TORRENT'], '.torrent dropped on the title bar is added')
assert.equal(calls.filter((call) => call[0] === 'addPath').length, 1, 'the .txt is ignored')
assert.equal(overlay.hidden, true, 'drop zone closed')
assert.ok(!document.body.classList.contains('dragging'))
console.log('drop on the title bar: ok')

const magnetDrag = {
  types: ['text/uri-list', 'text/plain'],
  files: [],
  getData: (type) => type === 'text/uri-list'
    ? '# link\nmagnet:?xt=urn:btih:feedface'
    : 'magnet:?xt=urn:btih:feedface'
}
document.getElementById('empty-state').dispatchEvent(dragEvent('drop', magnetDrag))
await tick(20)
assert.deepEqual(calls.at(-1), ['addText', 'magnet:?xt=urn:btih:feedface'], 'dropped magnet added once')
assert.equal(calls.filter((call) => call[1] === 'magnet:?xt=urn:btih:feedface').length, 1)
console.log('magnet drop: ok')

document.body.dispatchEvent(dragEvent('dragover', fileDrag))
assert.equal(overlay.hidden, false)
await tick(1100)
assert.equal(overlay.hidden, true, 'drop zone closed when the drag is abandoned')
console.log('abandoned drag: ok')

emitUpdate([])
await tick(20)
assert.equal(document.querySelectorAll('li.torrent').length, 0, 'removed torrents disappear')
assert.equal(document.getElementById('empty-state').hidden, false, 'empty state back')
console.log('empty list: ok')

console.log('ALL UI TESTS PASSED')
window.close()

function tick (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
