import assert from 'node:assert/strict'
import parseTorrent, { toTorrentFile } from 'parse-torrent'
import { isBlockedAddress, peerBlocklist, filterTrackers, sanitizeTorrent, isRiskyToOpen, findUnsafeFilePath, isUnsafeDownloadDir } from '../src/security.js'
import { createEngine, WEBRTC_TRACKERS, WEBRTC_SUPPORT } from '../src/engine.js'

const blocked = [
  '127.0.0.1',
  '127.255.255.254',
  '0.0.0.0',
  '10.1.2.3',
  '172.16.0.9',
  '172.31.255.1',
  '192.168.1.10',
  '169.254.169.254',
  '100.64.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  'fe80::1',
  'fd00::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:192.168.0.5'
]

for (const address of blocked) {
  assert.equal(isBlockedAddress(address), true, `${address} must be blocked`)
}
console.log(`internal addresses blocked: ${blocked.length}`)

const allowed = [
  '1.1.1.1',
  '8.8.8.8',
  '2001:4860:4860::8888',
  '2606:4700:4700::1111'
]

for (const address of allowed) {
  assert.equal(isBlockedAddress(address), false, `${address} must pass`)
}
console.log(`public addresses allowed: ${allowed.length}`)

assert.equal(isBlockedAddress('pas-une-ip'), true, 'garbage refused')
assert.equal(isBlockedAddress(null), true, 'null refused')
assert.equal(isBlockedAddress('[::1]'), true, 'IPv6 brackets handled')
assert.equal(isBlockedAddress('fe80::1%en0'), true, 'zone id handled')
console.log('invalid input: ok')

const trackers = [
  'udp://tracker.opentrackr.org:1337/announce',
  'http://127.0.0.1:9999/announce',
  'http://localhost:8000/announce',
  'http://192.168.1.1/announce',
  'http://169.254.169.254/latest/meta-data/',
  'wss://tracker.example.com/announce',
  'http://nas.local/announce',
  'http://[::1]:8080/announce',
  'not a url',
  null
]

const kept = filterTrackers(trackers)
assert.deepEqual(kept, [
  'udp://tracker.opentrackr.org:1337/announce',
  'wss://tracker.example.com/announce'
], 'only public trackers remain')
console.log('tracker filtering: ok')

const parsed = {
  infoHash: 'a'.repeat(40),
  announce: ['http://127.0.0.1/a', 'udp://tracker.public.org:80/a'],
  announceList: [
    ['http://10.0.0.1/b'],
    ['udp://tracker.public.org:80/a']
  ],
  name: 'fichier'
}

const sanitized = sanitizeTorrent(parsed)
assert.deepEqual(sanitized.announce, ['udp://tracker.public.org:80/a'])
assert.deepEqual(sanitized.announceList, [['udp://tracker.public.org:80/a']])
assert.equal(sanitized.infoHash, parsed.infoHash, 'the rest is preserved')
assert.equal(sanitized.name, parsed.name, 'the name is preserved')
console.log('torrent sanitizing: ok')

const magnet = await parseTorrent(
  'magnet:?xt=urn:btih:' + 'b'.repeat(40) +
  '&tr=udp%3A%2F%2Ftracker.public.org%3A80' +
  '&tr=http%3A%2F%2Flocalhost%3A8000%2Fannounce' +
  '&ws=http%3A%2F%2F127.0.0.1%3A8080%2Ffile' +
  '&ws=http%3A%2F%2Frouter.home.arpa%2Ffile' +
  '&ws=https%3A%2F%2Fcdn.example.org%2Ffile' +
  '&as=file%3A%2F%2F%2Fetc%2Fpasswd' +
  '&xs=http%3A%2F%2F169.254.169.254%2Fmeta.torrent' +
  '&x.pe=127.0.0.1:6881&x.pe=8.8.8.8:6881'
)
sanitizeTorrent(magnet)
assert.deepEqual(magnet.announce, ['udp://tracker.public.org:80'], 'local magnet tracker removed')
assert.deepEqual(magnet.urlList, ['https://cdn.example.org/file'], 'local and file:// web seeds removed')
assert.equal(magnet.xs, undefined, 'local exact source removed')
assert.deepEqual(magnet.peerAddresses, ['8.8.8.8:6881'], 'local magnet peer removed')
console.log('magnet sanitizing (ws, as, xs, x.pe): ok')

const traversal = await parseTorrent(toTorrentFile({
  info: {
    name: 'folder',
    'piece length': 16384,
    pieces: new Uint8Array(20),
    files: [{ path: ['..', '..', '..', 'Library', 'LaunchAgents', 'evil.plist'], length: 1 }]
  }
}))
// parse-torrent normalizes "..", but the file still escapes the torrent's own folder.
assert.equal(traversal.files[0].path, 'Library/LaunchAgents/evil.plist')
assert.equal(findUnsafeFilePath(traversal), 'Library/LaunchAgents/evil.plist', 'escape from the torrent folder detected')

const torrentOf = (name, files) => ({ name, files: files.map((filePath) => ({ path: filePath })) })
assert.equal(findUnsafeFilePath(torrentOf('Film', ['Film/a.mkv', 'Film/sous/b.srt'])), null, 'normal multi-file torrent')
assert.equal(findUnsafeFilePath(torrentOf('film.mkv', ['film.mkv'])), null, 'normal single-file torrent')
assert.equal(findUnsafeFilePath(torrentOf('.ssh', ['.ssh/authorized_keys'])), '.ssh', 'hidden name refused')
assert.equal(findUnsafeFilePath(torrentOf('a/b', ['a/b'])), 'a/b', 'name with a separator refused')
assert.equal(findUnsafeFilePath(torrentOf('Film', ['/etc/x'])), '/etc/x', 'absolute path refused')
console.log('booby-trapped file paths refused: ok')

const home = '/Users/test'
for (const dir of ['/Users/test', '/Users/test/Library', '/Users/test/Library/LaunchAgents', '/', '/Applications', '/System/Library', 'relatif']) {
  assert.equal(isUnsafeDownloadDir(dir, home), true, `${dir} refused as download folder`)
}
for (const dir of ['/Users/test/Downloads', '/Users/test/Movies/Torrents', '/Volumes/Disque/Torrents', '/Users/test/Library2']) {
  assert.equal(isUnsafeDownloadDir(dir, home), false, `${dir} accepted`)
}
console.log('sensitive download folders refused: ok')

for (const host of ['127.0.0.1', '::1', 'fe80::1', 'fd12::3', '::ffff:10.0.0.1', '192.168.1.20']) {
  assert.equal(peerBlocklist.contains(host), true, `${host} must be refused`)
}
assert.equal(peerBlocklist.contains('8.8.8.8'), false)
assert.equal(peerBlocklist.contains('2606:4700:4700::1111'), false)
console.log('peer blocklist (IPv4 + IPv6): ok')

for (const file of ['/d/Film.mkv', '/d/livre.pdf', '/d/musique.flac', '/d/image.JPG']) {
  assert.equal(isRiskyToOpen(file), false, `${file} opens`)
}
for (const file of ['/d/setup.command', '/d/run.SH', '/d/Jeu.app', '/d/x.terminal', '/d/lien.fileloc', '/d/installer.pkg', '/d/binaire', '/d/script.scpt']) {
  assert.equal(isRiskyToOpen(file), true, `${file} must never be launched`)
}
console.log('executables never opened: ok')

// Real engine, configured as in the app.
assert.equal(WEBRTC_SUPPORT, true, 'WebRTC available (node-datachannel loaded)')
const client = createEngine()
try {
  assert.deepEqual(client.tracker.announce, WEBRTC_TRACKERS, 'WebRTC trackers configured')
  assert.equal(client.blocked, peerBlocklist, 'IPv4 + IPv6 blocklist plugged in')
  assert.equal(client.natUpnp, false, 'no UPnP')
  assert.equal(client.natPmp, false, 'no NAT-PMP')

  const makeTorrent = async (name, isPrivate) => sanitizeTorrent(await parseTorrent(toTorrentFile({
    info: { name, 'piece length': 16384, pieces: new Uint8Array(20), length: 1, ...(isPrivate ? { private: 1 } : {}) },
    announce: ['udp://tracker.public.org:80']
  })))

  const publicTorrent = await addAndWait(client, await makeTorrent('public', false))
  for (const tracker of WEBRTC_TRACKERS) {
    assert.ok(publicTorrent.announce.includes(tracker), `${tracker} added to the public torrent`)
  }
  const privateTorrent = await addAndWait(client, await makeTorrent('prive', true))
  assert.ok(WEBRTC_TRACKERS.every((tracker) => !privateTorrent.announce.includes(tracker)), 'private torrent left untouched')
  console.log('WebRTC trackers added to public torrents only: ok')

  let blockedEvents = 0
  publicTorrent.on('blockedPeer', () => { blockedEvents += 1 })
  const localPeers = ['127.0.0.1:6881', '10.0.0.2:6881', '192.168.1.2:6881', '[::1]:6881', '[fe80::1]:6881', '[fd00::1]:6881']
  for (const peer of localPeers) {
    assert.equal(publicTorrent.addPeer(peer), false, `${peer} refused by the engine`)
  }
  assert.equal(blockedEvents, localPeers.length, 'every refusal goes through the blocklist')
  publicTorrent.addPeer('8.8.8.8:6881')
  assert.equal(blockedEvents, localPeers.length, 'public peer not blocked')
  console.log('local peers refused by the engine (IPv4 + IPv6): ok')
} finally {
  await new Promise((resolve) => client.destroy(resolve))
}

console.log('ALL SECURITY TESTS PASSED')

function addAndWait (client, torrentId) {
  return new Promise((resolve, reject) => {
    const torrent = client.add(torrentId, { paused: true, path: '/tmp/webtorrent2-test' })
    torrent.once('infoHash', () => resolve(torrent))
    torrent.once('error', reject)
  })
}
