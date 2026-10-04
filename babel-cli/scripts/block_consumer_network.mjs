// License: Apache-2.0 — see LICENSE
// Preloaded in consumer processes and their Node children, never during npm install.
import net from 'node:net'

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  let value = args[0]
  // net.createConnection passes the normalized [options, callback] array.
  while (Array.isArray(value)) value = value[0]
  const host = typeof value === 'object' && value !== null
    ? value.host ?? value.hostname
    : typeof args[1] === 'string' ? args[1] : undefined
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('External networking blocked in consumer verification')
  }
  return connect.apply(this, args)
}
globalThis.fetch = async () => { throw new Error('Inference blocked in consumer verification') }
