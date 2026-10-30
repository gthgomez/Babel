// Capture-only preload. Product runtime code is unchanged.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'

const deny = () => { throw new Error('Offline showcase forbids network access') }
globalThis.fetch = deny
http.request = http.get = https.request = https.get = deny
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny
syncBuiltinESMExports()
