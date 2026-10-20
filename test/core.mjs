import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import { isJpeg, parseRange, pickPreviewSource, playableFileIndex, readRange } from '../src/media.js'
import { createStreamServer, mediaRequestHandler } from '../src/streaming.js'
import { testDiscoveryRecovery } from './discovery.mjs'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'webtorrent2-test-'))
const seedDir = path.join(root, 'seed')
const outDir = path.join(root, 'out')
await fsp.mkdir(seedDir)
await fsp.mkdir(outDir)

const sourcePath = path.join(seedDir, 'payload.bin')
const payload = crypto.randomBytes(1024 * 1024 + 12345)
await fsp.writeFile(sourcePath, payload)

const videoPath = path.join(seedDir, 'sample.webm')
await fsp.copyFile(new URL('./fixtures/sample.webm', import.meta.url), videoPath)
const video = await fsp.readFile(videoPath)

const clientA = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, webSeeds: false })
const clientB = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, webSeeds: false })
let streams = null

try {
  await new Promise((resolve, reject) => {
    clientA.once('error', reject)
    clientA.once('listening', resolve)
  })

  const port = clientA.address()?.port
  assert.ok(Number.isInteger(port) && port > 0, 'the seeding client must listen on a TCP port')
  console.log(`seed port: ${port}`)

  const seeded = await new Promise((resolve, reject) => {
    clientA.once('error', reject)
    clientA.seed(sourcePath, { announce: [] }, resolve)
  })
  assert.ok(seeded.infoHash, 'info hash present')
  assert.ok(seeded.torrentFile?.length > 0, 'torrent file generated')
  console.log(`torrent created: ${seeded.infoHash}`)

  const parsed = await parseTorrent(seeded.torrentFile)
  assert.equal(parsed.infoHash, seeded.infoHash, 'parse-torrent reads the same info hash')
  console.log('parse-torrent: ok')

  const torrentPath = path.join(root, 'payload.torrent')
  await fsp.writeFile(torrentPath, seeded.torrentFile)

  const received = clientB.add(torrentPath, { path: outDir }, (torrent) => {
    torrent.addPeer(`127.0.0.1:${port}`)
  })

  received.on('error', (err) => {
    console.error('receive error:', err)
  })

  await waitFor(() => received.done, 30000, 'download finished')
  console.log(`downloaded: ${received.downloaded} bytes, ratio ${received.ratio.toFixed(2)}`)

  const duplicate = await clientB.get(seeded.infoHash)
  assert.equal(duplicate, received, 'client.get finds the torrent by info hash')

  const downloadedPath = path.join(outDir, 'payload.bin')
  const downloaded = await fsp.readFile(downloadedPath)
  assert.equal(downloaded.length, payload.length, 'same size')
  assert.ok(downloaded.equals(payload), 'same content')
  console.log('content verified: ok')

  // Byte ranges, as used by the window's <video> and by VLC.
  const readAll = async (file, start, end) => Buffer.concat(await Array.fromAsync(readRange(file, start, end)))
  const file = received.files[0]
  assert.ok((await readAll(file, 10, 20)).equals(payload.subarray(10, 21)), 'middle range')
  assert.ok((await readAll(file, 0, 0)).equals(payload.subarray(0, 1)), 'first byte only (end = 0)')
  assert.ok((await readAll(file, payload.length - 5, payload.length - 1)).equals(payload.subarray(-5)), 'last bytes')
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199, partial: true })
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999, partial: true })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999, partial: true })
  assert.deepEqual(parseRange(undefined, 1000), { start: 0, end: 999, partial: false })
  assert.equal(parseRange('bytes=1000-', 1000), null, 'past the end')
  assert.equal(parseRange('bytes=5-1', 1000), null, 'reversed')
  assert.equal(parseRange('items=0-1', 1000), null, 'wrong unit')
  console.log('byte ranges: ok')

  received.pause()
  assert.equal(received.paused, true, 'pause active')
  received.resume()
  assert.equal(received.paused, false, 'resume clears the pause')
  console.log('pause and resume: ok')

  await new Promise((resolve, reject) => {
    clientB.remove(received, { destroyStore: false }, (err) => err ? reject(err) : resolve())
  })
  assert.ok(fs.existsSync(downloadedPath), 'files stay when destroyStore is false')
  console.log('remove without deleting: ok')

  const pausedAdd = clientB.add(torrentPath, { path: outDir, paused: true })
  assert.equal(pausedAdd.paused, true, 'added paused')
  await new Promise((resolve) => pausedAdd.destroy(resolve))
  console.log('add paused: ok')

  // Card preview and VLC stream on a real video.
  const clip = await new Promise((resolve) => clientA.seed(videoPath, { announce: [] }, resolve))
  assert.deepEqual(pickPreviewSource(clip.files), { kind: 'video', index: 0 }, 'video chosen for the poster')
  assert.equal(playableFileIndex(clip.files), 0, 'video playable in VLC')
  const findFile = (infoHash, index) => (infoHash === clip.infoHash ? clip.files[index] || null : null)

  const posterPath = path.join(root, 'poster.jpg')
  const jpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])
  await fsp.writeFile(posterPath, jpeg)
  assert.equal(isJpeg(jpeg), true)
  assert.equal(isJpeg(Uint8Array.from([0x89, 0x50, 0x4E, 0x47])), false, 'a PNG is not taken for a JPEG')

  const handler = mediaRequestHandler({ findFile, posterFile: () => posterPath })
  const media = `webtorrent2://media/${clip.infoHash}/0`
  const partial = await handler(new Request(media, { headers: { Range: 'bytes=100-1099' } }))
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('Content-Range'), `bytes 100-1099/${video.length}`)
  assert.equal(partial.headers.get('Content-Type'), 'video/webm')
  assert.equal(partial.headers.get('Access-Control-Allow-Origin'), '*', 'CORS so the frame capture is not tainted')
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(video.subarray(100, 1100)), 'exact bytes served')
  const whole = await handler(new Request(media))
  assert.equal(whole.status, 200)
  assert.equal(Buffer.from(await whole.arrayBuffer()).length, video.length)
  assert.equal((await handler(new Request(media, { headers: { Range: `bytes=${video.length}-` } }))).status, 416)
  assert.equal((await handler(new Request(`webtorrent2://media/${clip.infoHash}/1`))).status, 404, 'unknown file')
  assert.equal((await handler(new Request(`webtorrent2://media/${'0'.repeat(40)}/0`))).status, 404, 'unknown torrent')
  assert.equal((await handler(new Request('webtorrent2://media/../../etc/passwd'))).status, 404, 'no path access')
  const poster = await handler(new Request(`webtorrent2://poster/${clip.infoHash}?v=1`))
  assert.ok(Buffer.from(await poster.arrayBuffer()).equals(Buffer.from(jpeg)), 'cached poster served')
  console.log('private media protocol: ok')

  streams = createStreamServer(findFile)
  const streamUrl = await streams.urlFor(clip.infoHash, 0, clip.files[0].name)
  const url = new URL(streamUrl)
  assert.equal(url.hostname, '127.0.0.1', 'local only')
  const ok = await request(url, { Range: 'bytes=0-499' })
  assert.equal(ok.status, 206)
  assert.ok(ok.body.equals(video.subarray(0, 500)), 'VLC gets the exact bytes')

  const wrongToken = new URL(streamUrl)
  wrongToken.pathname = wrongToken.pathname.replace(/^\/[a-f0-9]+/, '/' + 'f'.repeat(48))
  assert.equal((await request(wrongToken)).status, 404, 'wrong token refused')
  assert.equal((await request(url, { Host: 'evil.example:80' })).status, 403, 'DNS rebinding refused')
  assert.equal((await request(url, { Origin: 'https://evil.example' })).status, 403, 'browser pages refused')
  assert.equal((await request(url, {}, 'POST')).status, 405, 'only GET and HEAD')
  console.log('VLC stream server: ok')

} finally {
  streams?.close()
  await new Promise((resolve) => clientA.destroy(resolve))
  await new Promise((resolve) => clientB.destroy(resolve))
  await fsp.rm(root, { recursive: true, force: true })
}

await testDiscoveryRecovery()
console.log('ALL ENGINE TESTS PASSED')

function request (url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitFor (predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out: ${label}`)
}
