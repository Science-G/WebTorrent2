// Failed initial announces otherwise wait for the engine's regular interval
// (up to 30 minutes). Retry only until a tracker responds or a peer connects.
// A successful response with an empty swarm also stops recovery: respect the
// tracker's interval rather than polling it for peers.
export function recoverInitialDiscovery (torrent, {
  retryDelays = [15000, 30000, 60000, 120000]
} = {}) {
  let timer = null
  let attempt = 0
  let stopped = false

  function stop () {
    stopped = true
    clearTimeout(timer)
    timer = null
    torrent.removeListener('warning', onWarning)
    torrent.removeListener('trackerAnnounce', stop)
    torrent.removeListener('wire', stop)
    torrent.removeListener('close', stop)
  }

  function schedule () {
    if (stopped || timer !== null) return
    if (torrent.destroyed || attempt >= retryDelays.length) return stop()

    timer = setTimeout(() => {
      timer = null
      if (torrent.destroyed || torrent.numPeers > 0) return stop()
      const tracker = torrent.discovery?.tracker
      if (!tracker) return stop()
      if (!torrent.paused) {
        attempt += 1
        // Keep the existing info hash, tracker list and private flag. An update
        // works even when the failed 'started' request reached the tracker but
        // its response was lost; no duplicate 'completed' event is sent.
        tracker.update()
      }
      schedule()
    }, retryDelays[attempt])
    timer.unref?.()
  }

  function onWarning () {
    if (torrent.discovery?.tracker) schedule()
  }

  torrent.on('warning', onWarning)
  torrent.once('trackerAnnounce', stop)
  torrent.once('wire', stop)
  torrent.once('close', stop)
  if (torrent.destroyed) stop()
  return stop
}
