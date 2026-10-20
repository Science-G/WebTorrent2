// Decides whether the webtorrent engine should be updated. Prints key=value lines
// for $GITHUB_OUTPUT:
//   update=true|false   version=<latest>   current=<installed>   reason=<why>
//
// Guardrails before an automatic release:
// - same major version only: a major release can break the API, it needs a human;
// - the release must be at least COOLDOWN_DAYS old, so a broken or malicious
//   version has time to be noticed and pulled from npm before it ships here.
import fs from 'node:fs'

const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 3)
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const current = lock.packages?.['node_modules/webtorrent']?.version

const response = await fetch('https://registry.npmjs.org/webtorrent', {
  headers: { Accept: 'application/json' }
})
if (!response.ok) throw new Error(`npm registry answered ${response.status}`)
const registry = await response.json()

const latest = registry['dist-tags']?.latest
const published = new Date(registry.time?.[latest] || 0)
const ageDays = (Date.now() - published.getTime()) / 86400000
const major = (version) => Number(String(version).split('.')[0])
const newer = (a, b) => {
  const [x, y] = [a, b].map((version) => String(version).split('.').map(Number))
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}

let update = false
let reason
if (!current || !/^\d+\.\d+\.\d+$/.test(String(latest))) {
  reason = 'version unknown or malformed'
} else if (!newer(latest, current)) {
  reason = `already on ${current}`
} else if (major(latest) !== major(current)) {
  reason = `major release ${latest} needs a manual review`
} else if (ageDays < COOLDOWN_DAYS) {
  reason = `${latest} is ${ageDays.toFixed(1)} days old, waiting for ${COOLDOWN_DAYS}`
} else {
  update = true
  reason = `${current} -> ${latest}`
}

console.log(`update=${update}`)
console.log(`version=${latest}`)
console.log(`current=${current}`)
console.log(`reason=${reason}`)
