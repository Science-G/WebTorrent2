import { isIP } from 'node:net'
import path from 'node:path'

function ipv4ToInt (address) {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function inCidr4 (address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(network) & mask)
}

// Internal or special ranges: neither routable nor legitimate as BitTorrent peers.
export const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
]

const IPV4_BLOCKLIST = BLOCKED_IPV4_RANGES.map((entry) => {
  const [network, prefix] = entry.split('/')
  return [network, Number(prefix)]
})

export function isBlockedAddress (address) {
  if (typeof address !== 'string') return true

  const value = address.trim().replace(/^\[|\]$/g, '').split('%')[0]
  const family = isIP(value)

  if (family === 4) {
    return IPV4_BLOCKLIST.some(([network, prefix]) => inCidr4(value, network, prefix))
  }

  if (family === 6) {
    const lower = value.toLowerCase()

    if (lower === '::' || lower === '::1') return true
    if (/^f[cd]/.test(lower)) return true // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true // fe80::/10 lien local
    if (/^ff/.test(lower)) return true // multicast
    if (/^::ffff:/.test(lower)) {
      // IPv4-mapped: apply the IPv4 rule to the low part.
      return isBlockedAddress(lower.replace(/^::ffff:/, ''))
    }
    return false
  }

  // Neither IPv4 nor IPv6: a suspicious literal host name, refuse it.
  return true
}

// Replaces WebTorrent's blocklist (client.blocked). WebTorrent calls
// contains(ip) before adding a TCP or uTP peer, and on every incoming
// connection. Unlike a CIDR list, this one covers IPv6 too.
export const peerBlocklist = {
  contains: (host) => isBlockedAddress(host)
}

function hostnameOf (url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function isLocalHostname (hostname) {
  if (!hostname) return true
  if (isIP(hostname)) return isBlockedAddress(hostname)
  // An explicitly local host name must not be followed either.
  return /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.home\.arpa)$/i.test(hostname)
}

function filterUrls (urls, protocols) {
  const list = Array.isArray(urls) ? urls : (typeof urls === 'string' ? [urls] : [])

  return list.filter((url) => {
    if (typeof url !== 'string') return false
    let protocol
    try {
      protocol = new URL(url).protocol
    } catch {
      return false
    }
    if (!protocols.includes(protocol)) return false
    return !isLocalHostname(hostnameOf(url))
  })
}

const TRACKER_PROTOCOLS = ['udp:', 'http:', 'https:', 'ws:', 'wss:']
const HTTP_PROTOCOLS = ['http:', 'https:']

export function filterTrackers (trackers) {
  if (!Array.isArray(trackers)) return []
  return filterUrls(trackers, TRACKER_PROTOCOLS)
}

// Removes every local address a torrent could make the app contact:
// trackers, web seeds (ws/as, BEP 19), exact source (xs) and magnet peers (x.pe).
export function sanitizeTorrent (torrent) {
  if (!torrent || typeof torrent !== 'object') return torrent

  if (Array.isArray(torrent.announce)) {
    torrent.announce = filterTrackers(torrent.announce)
  }

  if (torrent.announceList) {
    torrent.announceList = torrent.announceList
      .map((tier) => filterTrackers(tier))
      .filter((tier) => tier.length > 0)
  }

  if (torrent.urlList) {
    torrent.urlList = filterUrls(torrent.urlList, HTTP_PROTOCOLS)
  }

  if (torrent.xs) {
    const xs = filterUrls(torrent.xs, HTTP_PROTOCOLS)
    if (xs.length > 0) torrent.xs = xs
    else delete torrent.xs
  }

  if (Array.isArray(torrent.peerAddresses)) {
    torrent.peerAddresses = torrent.peerAddresses.filter((address) => {
      const host = String(address).replace(/:\d+$/, '')
      return !isBlockedAddress(host)
    })
  }

  return torrent
}

// Types that run code or a command when opened. The Open button never
// launches them: it shows them in Finder instead.
const RISKY_EXTENSIONS = new Set([
  '.app', '.action', '.applescript', '.bash', '.command', '.csh', '.definition',
  '.dmg', '.fileloc', '.inetloc', '.jar', '.ksh', '.mpkg', '.osax', '.pkg',
  '.prefpane', '.py', '.rb', '.pl', '.scpt', '.scptd', '.sh', '.shortcut',
  '.terminal', '.tool', '.url', '.webloc', '.workflow', '.zsh'
])

export function isRiskyToOpen (filePath) {
  if (typeof filePath !== 'string' || !filePath) return true
  const extension = path.extname(filePath).toLowerCase()
  if (!extension) return true // no extension: possibly an executable
  return RISKY_EXTENSIONS.has(extension)
}

// Every file must stay inside the torrent's own folder (its name). A path that
// escapes it ("../Library/LaunchAgents/x.plist") or a hidden name (".ssh")
// could write where macOS reads settings or launches code.
export function findUnsafeFilePath (torrent) {
  const name = torrent?.name
  if (typeof name !== 'string' || !name || name.startsWith('.') || name.includes('/')) {
    return String(name ?? '(no name)')
  }

  for (const file of torrent.files || []) {
    const filePath = String(file?.path ?? '')
    const parts = filePath.split('/')
    if (path.isAbsolute(filePath) || parts[0] !== name || parts.includes('..')) {
      return filePath
    }
  }
  return null
}

// Folders where a download could tamper with the system or the session:
// the home folder itself, ~/Library, and system folders.
export function isUnsafeDownloadDir (directory, home) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return true
  const target = path.resolve(directory)
  const homeDir = path.resolve(home)
  if (target === homeDir || target === path.parse(target).root) return true

  const forbidden = [
    path.join(homeDir, 'Library'),
    '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private', '/var'
  ]
  return forbidden.some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`))
}
