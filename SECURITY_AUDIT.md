# Security audit

Audited version: WebTorrent2 0.2.0, October 19, 2026.
Scope: main process, interface page, the `webtorrent` 3.0.21 engine and its
configuration, media previews and the VLC stream, the shipped macOS package, the
build chain.
Status: fixes applied, covered by `npm test` and by the build's check launch.

## Summary

The review of 0.1.3 found five real flaws, two of which the previous audit wrongly
listed as covered. All are fixed in 0.2.0 and tested against the real WebTorrent
engine, not only against isolated functions. The media features added in 0.2.0
(card previews, Play in VLC) were designed with the same constraints and are
reviewed below.

| Ref | Flaw in 0.1.3 | Severity | Fix in 0.2.0 |
| --- | --- | --- | --- |
| A-01 | A torrent could write outside its own folder (`../Library/LaunchAgents/x.plist`) | high if the download folder is the home folder | paths checked before any write, sensitive folders refused |
| A-02 | **Open** launched any file, `.command` scripts included, with no Gatekeeper check | high | executables never launched, downloads quarantined |
| A-03 | The IPv6 local peer filter did nothing | medium | IPv4 + IPv6 blocklist plugged into the engine |
| A-04 | Web seeds (`ws`, `as`) and exact source (`xs`) unfiltered: HTTP requests to the local network were possible | medium | filtered like trackers |
| A-05 | NAT-PMP on: a port opened on the router despite the opposite promise | low | NAT-PMP and UPnP off |

## Fixes

### A-01 Writing outside the torrent folder

`parse-torrent` normalizes `..` but does not keep the file inside the torrent's
folder: `folder/../../../Library/LaunchAgents/evil.plist` becomes
`Library/LaunchAgents/evil.plist`, under the download folder. With `~/Downloads`
that is harmless. With the home folder as destination, it is an agent launched at
every login. A hidden torrent name (`.ssh`) had the same problem.

Fix (`src/security.js`, `src/main.js`):

- `findUnsafeFilePath` requires every file to sit in the folder named after the
  torrent, with no `..`, no absolute path, and refuses hidden names or names
  containing `/`;
- checked before `client.add` for a `.torrent`, and on the `metadata` event for a
  magnet link. In the latter case the torrent is destroyed synchronously: WebTorrent
  checks `destroyed` right after that event, before verifying pieces or writing;
- `isUnsafeDownloadDir` refuses the home folder itself, `~/Library` and system
  folders as destination, when chosen and when `config.json` is loaded.

### A-02 Launching an executable with one click

The previous audit relied on Gatekeeper (R-03). But an Electron app does not
quarantine the files it writes: Gatekeeper saw nothing, and **Open** on a
`.command` ran it in Terminal.

Fix:

- `isRiskyToOpen`: apps, scripts, shortcuts (`.fileloc`, `.webloc`, `.inetloc`),
  installers and files without an extension are never opened, only shown in Finder;
- a multi-file torrent opens its folder rather than its first file;
- `LSFileQuarantineEnabled` in `Info.plist`: macOS sets `com.apple.quarantine` on
  files the app creates, so Gatekeeper checks them if the user launches them.

To verify on a Mac after installing (cannot be checked from the build runner):
`xattr -l ~/Downloads/<downloaded file>` must list `com.apple.quarantine`.

### A-03 Local IPv6 peers

The previous audit listed three barriers. The third, a `torrent.on('peer')`
listener, did nothing: WebTorrent passes an `ip:port` string there, the code read
`peer.host`, always `undefined`. The CIDR blocklist only covered IPv4. `::1`,
`fe80::/10` and `fc00::/7` got through.

Fix: `client.blocked` is replaced by `peerBlocklist`, which WebTorrent consults
before adding any TCP or uTP peer and on every incoming connection. It covers IPv4,
IPv6 and IPv4-mapped addresses. The test calls `torrent.addPeer` on the real engine
and checks the `blockedPeer` event.

### A-04 Web seeds and exact source

`sanitizeTorrent` only filtered trackers. A magnet link with
`ws=http://192.168.1.1/...` or `xs=http://169.254.169.254/...` triggered HTTP
requests to those addresses. `urlList`, `xs` and `peerAddresses` (`x.pe`) are now
filtered, and only `http` and `https` are accepted for web seeds.

### A-05 Port mapping

`natPmp: true` contradicted the code comment and the documentation. UPnP and
NAT-PMP are off: the app opens no port on the router.

## Media features (new in 0.2.0)

### Card previews

The window needs to read video and image files from torrents to build card
backgrounds. WebTorrent Desktop did this through a local HTTP server without any
access control. WebTorrent2 uses a private protocol instead (`webtorrent2://`):

- registered only inside the app's own session, nothing listens on the network,
  other apps and web pages cannot reach it;
- only serves `media/<info hash>/<file index>` for files whose type is a previewable
  video or image, and `poster/<info hash>`; anything else returns 404, there is no
  path in the URL to traverse;
- the page's content security policy only allows media and images from `'self'`
  and this protocol.

Untrusted video and images are decoded by Chromium inside the sandboxed renderer,
the same exposure as a browser playing a video. The poster sent back to the main
process is checked (JPEG signature, 2 MB maximum) before it is written, and the
file name on disk comes from the info hash, never from the torrent.

### Play in VLC

A file still downloading is streamed to VLC over HTTP, like WebTorrent Desktop
did, with these limits:

- bound to `127.0.0.1` only, started on the first use, closed when the app quits;
- a 192-bit random token in every address, compared in constant time;
- the `Host` header must be exactly `127.0.0.1:<port>` (blocks DNS rebinding);
- requests with an `Origin` header are refused, as are methods other than GET and
  HEAD; only video and audio files of known torrents are served.

VLC is launched directly with an argument list, never through a shell, so a file
name cannot inject a command.

## Added hardening

| Area | Measure |
| --- | --- |
| Page | CSP `default-src 'none'`, no `'unsafe-inline'` (progress bars and posters set through CSSOM), `connect-src 'none'` |
| Navigation | every navigation refused (`will-navigate`); a `.torrent` dropped outside the drop zone is added instead of opened |
| Web contents | no windows, no `webview`, no permissions (camera, microphone, notifications...) |
| IPC | every call checks that the sender is the app's own local page |
| Input | `.torrent` capped at 32 MB, HTTP links not accepted (dead code removed) |
| Binary | Electron fuses: `RunAsNode`, `NODE_OPTIONS` and `--inspect` off, app loaded from the asar only |
| Signature | full ad hoc signature of the bundle, checked with `codesign --verify --deep --strict` at build time |
| Build | the app is really launched after signing (`scripts/after-sign.cjs`): page, bridge, styles, logo, WebRTC, engine, and a poster built from a test video must all work, or no DMG is produced |

## Checked and found sound

- **HTML injection**: names and errors go through `escapeHtml`, strict CSP, no `eval`.
- **Isolation**: `contextIsolation`, `sandbox`, `nodeIntegration: false`, a single
  local page.
- **Dependencies**: `npm audit --omit=dev` reports `ip` through `bittorrent-tracker`,
  in its tracker server code (`lib/server/parse-udp.js`), which the app never
  imports; `ip` is pinned to 1.1.9.

## Remaining risks

| Ref | Topic | Why it is accepted |
| --- | --- | --- |
| R-01 | App not notarized | Needs a paid Apple Developer certificate. Mitigated by the ad hoc signature and the published SHA-256 fingerprint. |
| R-02 | IP address visible | A property of BitTorrent and WebRTC: peers, trackers and public STUN servers (Google and Twilio, WebRTC's defaults) see your public IP. WebRTC can also reveal your local address to peers. Use a VPN if that matters to you. |
| R-03 | Host names resolving locally | A tracker or web seed `http://public-name.example` that resolves to a local IP is not blocked: the filter works on literal addresses. A blind request, the attacker never reads the answer. |
| R-04 | WebSocket trackers added | The info hash of public torrents is announced to three more trackers. That is the price of WebRTC; private torrents are excluded. |
| R-05 | Previews fetch pieces early | Building a poster or a hover preview reads parts of the video out of order, as WebTorrent Desktop did. Nothing is sent to anyone because of it. |
| R-06 | `npmRebuild: false` | `node-datachannel` uses N-API, compatible with the Electron runtime. |

## Re-running the audit

```bash
npm test
npm audit --omit=dev --audit-level=none
```

Files: `src/security.js` (filters), `src/engine.js` (engine settings),
`src/media.js` and `src/streaming.js` (previews, byte ranges, VLC stream),
`src/main.js` (where the checks apply), `test/security.mjs` and `test/core.mjs`
(including tests on the real engine and the real streams),
`scripts/after-sign.cjs` (package check).
