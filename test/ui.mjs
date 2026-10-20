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
let emitUpdate = null
let emitError = null

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
  settings: async () => ({ downloadPath: '/Users/test/Downloads', version: '0.2.0' }),
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

const magnetInput = document.getElementById('magnet-input')
magnetInput.value = 'magnet:?xt=urn:btih:cafebabe'
document.getElementById('add-magnet').click()
await tick(20)
assert.deepEqual(calls.at(-1), ['addText', 'magnet:?xt=urn:btih:cafebabe'], 'magnet sent')
assert.equal(magnetInput.value, '', 'field cleared after adding')
console.log('add magnet: ok')

document.getElementById('paste-btn').click()
await tick(20)
assert.equal(magnetInput.value, 'magnet:?xt=urn:btih:deadbeef', 'paste from clipboard')
console.log('paste: ok')

emitError('test error')
await tick(20)
assert.equal(document.getElementById('toast').hidden, false, 'toast visible')
assert.equal(document.getElementById('toast').textContent, 'test error')
assert.ok(document.getElementById('toast').classList.contains('toast--error'), 'error toast')
console.log('toast: ok')

// Drag and drop: anywhere in the window, title bar included.
function dragEvent (type, data) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  return event
}

const overlay = document.getElementById('drop-overlay')
const titlebar = document.querySelector('.titlebar')
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

function tick (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
