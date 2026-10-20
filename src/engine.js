import WebTorrent from 'webtorrent'
import { peerBlocklist } from './security.js'

// WebSocket trackers: this is how two WebRTC peers find each other and swap
// their connection offers. Added to every public torrent (WebTorrent skips them
// for private torrents). Checked reachable on 2026-10-19.
export const WEBRTC_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.novage.com.ua'
]

export function clientOptions () {
  return {
    utp: true,
    dht: true,
    tracker: { announce: WEBRTC_TRACKERS },
    webSeeds: true,
    // No port mapping on the router, neither UPnP nor NAT-PMP: outgoing
    // traffic and WebRTC are enough.
    natUpnp: false,
    natPmp: false,
    maxConns: 100
  }
}

export function createEngine () {
  const client = new WebTorrent(clientOptions())
  // Checked before any connection: WebTorrent consults client.blocked before
  // adding a TCP/uTP peer and on every incoming connection.
  client.blocked = peerBlocklist
  return client
}

export const WEBRTC_SUPPORT = Boolean(WebTorrent.WEBRTC_SUPPORT)
