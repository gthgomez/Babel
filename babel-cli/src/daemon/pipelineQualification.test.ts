import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import test from 'node:test'
import { DaemonIpcServer } from './ipc.js'
import { rejectUnqualifiedDaemonPipeline } from './pipelineQualification.js'

test('streaming IPC rejects the quarantined pipeline before starting work', async () => {
  const ipc = new DaemonIpcServer(); let starts = 0
  ipc.onStreaming('pipeline.run', async (_params, socket) => {
    if (rejectUnqualifiedDaemonPipeline(socket)) return
    starts++
  })
  await ipc.listen({ host: '127.0.0.1', port: 0 })
  try {
    const address = (ipc as unknown as { server: Server }).server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1'); let data = ''
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, method: 'pipeline.run', params: {} })}\n`))
      socket.on('data', chunk => { data += String(chunk) }); socket.on('end', () => resolve(data)); socket.on('error', reject)
    })
    assert.match(response, /UNSUPPORTED_OPERATION.*quarantined/); assert.equal(starts, 0)
  } finally { await new Promise<void>((resolve, reject) => (ipc as unknown as { server: Server }).server.close(error => error ? reject(error) : resolve())) }
})

test('explicit daemon pipeline selection is rejected without connecting or falling back', async () => {
  const previous = process.env['BABEL_DAEMON_ENABLED']; const desktop = process.env['BABEL_DESKTOP_IPC']; const daemon = process.env['BABEL_DAEMON']; const previousFetch = globalThis.fetch
  delete process.env['BABEL_DESKTOP_IPC']; delete process.env['BABEL_DAEMON']
  globalThis.fetch = async () => { throw new Error('Unexpected provider request') }
  try {
    const { runBabelPipeline } = await import('../pipeline.js')
    for (const requested of ['true', '1', 'yes']) {
      process.env['BABEL_DAEMON_ENABLED'] = requested
      await assert.rejects(runBabelPipeline('fixture task'), /UNSUPPORTED_OPERATION.*quarantined/)
    }
  } finally {
    globalThis.fetch = previousFetch
    for (const [name, value] of Object.entries({ BABEL_DAEMON_ENABLED: previous, BABEL_DESKTOP_IPC: desktop, BABEL_DAEMON: daemon })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})
