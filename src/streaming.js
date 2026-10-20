import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { Readable, pipeline } from 'node:stream'
import { checkStreamRequest, isPlayable, mediaContentType, parseRange, rangeHeaders, readRange } from './media.js'

export const MEDIA_SCHEME = 'webtorrent2'

// Private scheme for the window: <video> can stream from it, and with CORS the
// canvas that captures the poster frame is not tainted. Nothing listens on the
// network: only this app's own page can load these URLs.
export const MEDIA_SCHEME_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}

const HASH = /^[a-f0-9]{40}$/

const empty = (status, headers) => new Response(null, { status, headers })

// webtorrent2://media/<infoHash>/<fileIndex>  a video or image file of a torrent
// webtorrent2://poster/<infoHash>             the cached card background
export function mediaRequestHandler ({ findFile, posterFile }) {
  return async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return empty(400)
    }
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.hostname === 'poster' && parts.length === 1 && HASH.test(parts[0])) {
      try {
        const data = await fsp.readFile(posterFile(parts[0]))
        return new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
      } catch {
        return empty(404)
      }
    }

    if (url.hostname === 'media' && parts.length === 2 && HASH.test(parts[0]) && /^\d+$/.test(parts[1])) {
      const file = findFile(parts[0], Number(parts[1]))
      const type = file ? mediaContentType(file.name) : null
      if (!type) return empty(404)

      const range = parseRange(request.headers.get('Range'), file.length)
      if (!range) return empty(416, { 'Content-Range': `bytes */${file.length}` })

      const status = range.partial ? 206 : 200
      const headers = { ...rangeHeaders(file, range, type), 'Access-Control-Allow-Origin': '*' }
      if (request.method === 'HEAD') return empty(status, headers)
      return new Response(ReadableStream.from(readRange(file, range.start, range.end)), { status, headers })
    }

    return empty(404)
  }
}

// Local HTTP stream so VLC can play a file while it downloads, like WebTorrent
// Desktop did, but bound to 127.0.0.1 and locked by a random token. Started on
// the first "Play in VLC", closed when the app quits.
export function createStreamServer (findFile) {
  const token = crypto.randomBytes(24).toString('hex')
  let server = null
  let listening = null

  function serve (request, response) {
    const check = checkStreamRequest(request, token, server.address().port)
    const file = check.status === 200 ? findFile(check.infoHash, check.index) : null
    if (!file || !isPlayable(file.name)) {
      response.writeHead(check.status === 200 ? 404 : check.status)
      return response.end()
    }

    const range = parseRange(request.headers.range, file.length)
    if (!range) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.length}` })
      return response.end()
    }

    const type = mediaContentType(file.name) || 'application/octet-stream'
    response.writeHead(range.partial ? 206 : 200, rangeHeaders(file, range, type))
    if (request.method === 'HEAD') return response.end()
    pipeline(Readable.from(readRange(file, range.start, range.end)), response, () => {})
  }

  function start () {
    return new Promise((resolve, reject) => {
      server = http.createServer(serve)
      server.once('error', (err) => {
        listening = null
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
  }

  return {
    async urlFor (infoHash, index, name) {
      if (!listening) listening = start()
      const port = await listening
      return `http://127.0.0.1:${port}/${token}/${infoHash}/${index}/${encodeURIComponent(name)}`
    },
    close () {
      server?.close()
      server = null
      listening = null
    }
  }
}

const vlcBinary = (bundle) => path.join(bundle, 'Contents', 'MacOS', 'VLC')

export async function findVlc () {
  const usual = ['/Applications/VLC.app', path.join(os.homedir(), 'Applications', 'VLC.app')]
  for (const bundle of usual) {
    if (fs.existsSync(vlcBinary(bundle))) return bundle
  }

  // Installed elsewhere: ask Spotlight for VLC's bundle identifier.
  const found = await new Promise((resolve) => {
    execFile('mdfind', ['kMDItemCFBundleIdentifier == "org.videolan.vlc"'], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
  return found.split('\n').map((line) => line.trim())
    .find((line) => line.endsWith('.app') && fs.existsSync(vlcBinary(line))) || null
}

// Arguments go straight to VLC, no shell involved.
export function launchVlc (bundle, target, title) {
  const child = spawn(vlcBinary(bundle), ['--play-and-exit', `--meta-title=${title}`, target], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', (err) => console.error('vlc launch failed', err))
  child.unref()
}
