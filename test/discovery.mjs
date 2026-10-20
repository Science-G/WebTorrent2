import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import { Server } from 'bittorrent-tracker'
import parseTorrent from 'parse-torrent'
import { recoverInitialDiscovery } from '../src/discovery.js'
import { sanitizeTorrent } from '../src/security.js'

export async function testDiscoveryRecovery () {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webtorrent2-discovery-'))
  const server = new Server({ udp: false, ws: false, stats: false })
  const clients = []
  let online = true
  let requests = 0
  server.http.on('request', (_req, res) => {
    requests += 1
    if (!online) {
      res.writeHead(503)
      res.end('temporarily unavailable')
    }
  })

  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const tracker = `http://127.0.0.1:${server.http.address().port}/announce`
    const makeClient = (track = true) => {
      const client = new WebTorrent({
        dht: false, lsd: false, utp: false,
        tracker: track ? { announce: [tracker] } : false,
        natUpnp: false, natPmp: false
      })
      clients.push(client)
      return client
    }
    const originalClient = makeClient(false)
    const payload = Buffer.alloc(1024 * 1024, 42)
    const source = path.join(root, 'payload.bin')
    await fs.writeFile(source, payload)
    const original = await new Promise((resolve) => originalClient.seed(source, { announce: [] }, resolve))
    const torrentFile = Buffer.from(original.torrentFile)
    await new Promise((resolve) => originalClient.destroy(resolve))

    // A downloader is already waiting when the completed torrent is restored.
    // Discovery must initiate the connection; no addPeer() shortcut is used.
    const received = makeClient().add(torrentFile, { path: path.join(root, 'out') })
    await waitEvent(received, 'trackerAnnounce')
    online = false
    const restored = makeClient().add(sanitizeTorrent(await parseTorrent(torrentFile)), { path: root })
    const warning = waitEvent(restored, 'warning')
    recoverInitialDiscovery(restored, { retryDelays: [200, 200, 200] })
    await warning
    assert.equal(restored.done, true, 'completed files restored before the tracker responds')
    assert.equal(restored.numPeers, 0, 'failed initial announces leave the seed without peers')
    online = true
    await waitEvent(received, 'done')
    assert.ok((await fs.readFile(path.join(root, 'out', 'payload.bin'))).equals(payload))
    assert.ok(restored.uploaded >= payload.length, 'restored seed uploads after automatic recovery')
    console.log('restored seed recovers from failed initial tracker announces: ok')

    // An acknowledged but empty swarm must keep the tracker's normal interval.
    const idleSource = path.join(root, 'idle.bin')
    await fs.writeFile(idleSource, Buffer.from('idle swarm'))
    const idleSeed = await new Promise((resolve) => makeClient(false).seed(idleSource, { announce: [] }, resolve))
    const idleTorrentFile = Buffer.from(idleSeed.torrentFile)
    const idle = makeClient().add(idleTorrentFile, { path: path.join(root, 'empty'), paused: true })
    recoverInitialDiscovery(idle, { retryDelays: [50, 50] })
    await waitEvent(idle, 'trackerAnnounce')
    const acknowledgedRequests = requests
    await delay(250)
    assert.equal(requests, acknowledgedRequests, 'no retry after a valid tracker response')
    assert.equal(idle.listenerCount('warning'), 0, 'recovery listeners removed on success')
    await new Promise((resolve) => idle.destroy(resolve))

    // Paused torrents must not produce recovery requests, and closing them
    // must cancel the pending timer and remove all recovery listeners.
    online = false
    const paused = makeClient().add(torrentFile, { path: root, paused: true })
    recoverInitialDiscovery(paused, { retryDelays: [50, 50] })
    await waitEvent(paused, 'warning')
    await delay(100)
    const pausedRequests = requests
    await delay(150)
    assert.equal(requests, pausedRequests, 'recovery makes no requests while paused')
    await new Promise((resolve) => paused.destroy(resolve))
    assert.equal(paused.listenerCount('warning'), 0, 'recovery listeners removed on close')
    await delay(100)
    const closedRequests = requests
    await delay(150)
    assert.equal(requests, closedRequests, 'no recovery request after close')
    console.log('tracker interval, pause and close respected: ok')

    // A tracker that stays offline must not trigger unbounded requests.
    const beforeFailure = requests
    const exhausted = makeClient().add(idleTorrentFile, { path: root })
    const failed = waitEvent(exhausted, 'warning')
    recoverInitialDiscovery(exhausted, { retryDelays: [50, 50] })
    await failed
    await delay(250)
    assert.equal(requests - beforeFailure, 4, 'started, completed and exactly two recovery announces')
    assert.equal(exhausted.listenerCount('warning'), 0, 'listeners removed when retries are exhausted')
    const exhaustedRequests = requests
    await delay(150)
    assert.equal(requests, exhaustedRequests, 'no more retries after exhaustion')
    console.log('initial tracker retries bounded: ok')
  } finally {
    for (const client of clients) {
      if (!client.destroyed) await new Promise((resolve) => client.destroy(resolve))
    }
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitEvent (emitter, event) {
  const timer = setTimeout(() => emitter.emit('error', new Error(`timed out waiting for ${event}`)), 20000)
  try {
    return await once(emitter, event)
  } finally {
    clearTimeout(timer)
  }
}
