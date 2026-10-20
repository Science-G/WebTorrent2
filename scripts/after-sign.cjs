// Checks the macOS package right after the ad hoc signature, on the runner:
// 1. the signature covers the whole bundle (otherwise macOS says "damaged");
// 2. the app really starts (--smoke-test: bridge, page, WebRTC, engine), builds
//    a card poster from a real video (--smoke-video) and quits cleanly.
// Any failure stops the build: no release ships with an app that does not start.
'use strict'

const { execFileSync, spawn } = require('node:child_process')
const path = require('node:path')

const CHECK_TIMEOUT_MS = 150000

// Output is streamed live, and the app is killed hard on timeout: a hang must
// fail fast and show where it stopped.
function runCheck (binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => {
      process.stdout.write('check launch timed out, killing the app\n')
      child.kill('SIGKILL')
    }, CHECK_TIMEOUT_MS)

    // 'exit' rather than 'close': helper processes may keep the pipes open.
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, output })
    })
  })
}

exports.default = async function afterSign (context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return

  const name = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${name}.app`)
  const binary = path.join(appPath, 'Contents', 'MacOS', name)
  const video = path.join(__dirname, '..', 'test', 'fixtures', 'sample.webm')

  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })

  const result = await runCheck(binary, ['--smoke-test', `--smoke-video=${video}`])
  if (result.code !== 0 || !result.output.includes('SMOKE OK')) {
    throw new Error(`check launch failed (code ${result.code}, signal ${result.signal})`)
  }
}
