import crypto from 'node:crypto'
import path from 'node:path'

// Containers Chromium can decode in the window, used for the card preview.
const PREVIEW_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska'
}

// What VLC plays and is worth a "Play in VLC" button.
const PLAYABLE = new Set([
  ...Object.keys(PREVIEW_TYPES),
  '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.3gp',
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav'
])

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.alac', '.aiff'])

// Larger images are not worth decoding just for a card background.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const extensionOf = (name) => path.extname(String(name || '')).toLowerCase()
const stemOf = (name) => path.basename(String(name || ''), path.extname(String(name || ''))).toLowerCase()

export function previewType (name) {
  return PREVIEW_TYPES[extensionOf(name)] || null
}

export function imageType (name) {
  return IMAGE_TYPES[extensionOf(name)] || null
}

// Same keywords as WebTorrent Desktop for album art, plus video artwork names.
const ART_SCORES = [
  ['poster', 90], ['cover', 80], ['folder', 80], ['front', 80], ['album', 80],
  ['fanart', 60], ['thumb', 40], ['back', 20], ['spectrogram', -80]
]

function artScore (name) {
  const stem = stemOf(name)
  for (const [keyword, score] of ART_SCORES) {
    if (stem.includes(keyword)) return score
  }
  return 0
}

function usableImages (files) {
  return (files || [])
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => imageType(file?.name) && file.length > 0 && file.length <= MAX_IMAGE_BYTES)
}

function bestArt (files, minimumScore) {
  let best = null
  for (const candidate of usableImages(files)) {
    const score = artScore(candidate.file.name)
    if (score < minimumScore) continue
    if (!best || score > best.score || (score === best.score && candidate.file.length > best.file.length)) {
      best = { ...candidate, score }
    }
  }
  return best
}

// Picks what the card background is made from, following WebTorrent Desktop:
// 1. artwork shipped in the torrent (poster.jpg, cover.png...);
// 2. otherwise the dominant media type by total size:
//    video -> a frame of the largest playable video,
//    audio -> the most cover-like image,
//    image -> the largest image.
export function pickPreviewSource (files) {
  const list = files || []
  const art = bestArt(list, 40)
  if (art) return { kind: 'image', index: art.index }

  const total = { video: 0, audio: 0, image: 0 }
  for (const file of list) {
    const extension = extensionOf(file?.name)
    if (PLAYABLE.has(extension) && !AUDIO.has(extension)) total.video += file.length
    else if (AUDIO.has(extension)) total.audio += file.length
    else if (IMAGE_TYPES[extension]) total.image += file.length
  }

  const dominant = Object.entries(total).sort((a, b) => b[1] - a[1])[0]
  if (!dominant || dominant[1] === 0) return null

  if (dominant[0] === 'video') {
    const index = previewFileIndex(list)
    return index === -1 ? null : { kind: 'video', index }
  }
  if (dominant[0] === 'audio') {
    const cover = bestArt(list, 0)
    return cover ? { kind: 'image', index: cover.index } : null
  }
  const images = usableImages(list)
  if (images.length === 0) return null
  const largest = images.reduce((a, b) => (b.file.length > a.file.length ? b : a))
  return { kind: 'image', index: largest.index }
}

export function mediaContentType (name) {
  return previewType(name) || imageType(name)
}

export function isPlayable (name) {
  return PLAYABLE.has(extensionOf(name))
}

function largestIndex (files, accept) {
  let best = -1
  for (let index = 0; index < (files?.length || 0); index += 1) {
    const file = files[index]
    if (!accept(file?.name)) continue
    if (best === -1 || file.length > files[best].length) best = index
  }
  return best
}

export const previewFileIndex = (files) => largestIndex(files, (name) => previewType(name) !== null)
export const playableFileIndex = (files) => largestIndex(files, isPlayable)

// Parses an HTTP Range header ("bytes=start-end", "bytes=start-", "bytes=-suffix").
// Returns null when the range cannot be satisfied.
export function parseRange (header, length) {
  if (!Number.isSafeInteger(length) || length <= 0) return null
  if (!header) return { start: 0, end: length - 1, partial: false }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match || (match[1] === '' && match[2] === '')) return null

  let start
  let end
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return null
    start = Math.max(0, length - suffix)
    end = length - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? length - 1 : Math.min(Number(match[2]), length - 1)
  }

  if (start >= length || end < start) return null
  return { start, end, partial: true }
}

// Reads exactly [start, end] from a WebTorrent file. WebTorrent treats end = 0 as
// "until the end of the file", so the last byte is trimmed by hand.
export async function * readRange (file, start, end) {
  let remaining = end - start + 1
  for await (const chunk of file[Symbol.asyncIterator]({ start, end: Math.max(end, 1) })) {
    if (remaining <= 0) break
    const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    remaining -= piece.length
    yield piece
  }
}

export function rangeHeaders (file, range, contentType) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(range.end - range.start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.length}`
  return headers
}

export function safeEqual (given, expected) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Local stream for VLC: only GET/HEAD, only 127.0.0.1 with the exact port (blocks
// DNS rebinding), no browser Origin, and a random token in the path.
export function checkStreamRequest (request, token, port) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405 }
  if (request.headers.host !== `127.0.0.1:${port}`) return { status: 403 }
  if (request.headers.origin) return { status: 403 }

  const [, given, infoHash, index] = String(request.url || '').split('?')[0].split('/')
  if (!safeEqual(given, token)) return { status: 404 }
  if (!/^[a-f0-9]{40}$/.test(infoHash || '') || !/^\d+$/.test(index || '')) return { status: 404 }
  return { status: 200, infoHash, index: Number(index) }
}

export function isJpeg (bytes) {
  return bytes instanceof Uint8Array && bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
}
