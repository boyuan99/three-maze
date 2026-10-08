// Is a TCP port on this machine already taken? The backend's find_available_port probes with
// SO_REUSEADDR, which on Windows does not notice a port another process listens on, so a second
// backend on 8765 crashes on bind instead of moving to the next port. The runner therefore checks
// the ports itself before it starts anything.
import net from 'node:net'

function connects (host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function listenError (host, port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', (e) => resolve(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code) ? null : e.code || String(e)))
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(null)))
  })
}

/** null when the port is free on localhost (IPv4 and IPv6), else what shows it is taken */
export async function portTaken (port, { timeoutMs = 500 } = {}) {
  for (const host of ['127.0.0.1', '::1']) {
    const err = await listenError(host, port)
    if (err) return `cannot listen on ${host}:${port} (${err})`
    if (await connects(host, port, timeoutMs)) return `something accepts connections on ${host}:${port}`
  }
  return null
}
