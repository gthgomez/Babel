import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'

test('OTLP and Langfuse adapter export a real span as JSON to an isolated loopback collector', { timeout: 10_000 }, async t => {
  const fixture = prepareSyntheticProviderFixture()
  const previousEnv = process.env
  process.env = fixture.env
  t.after(() => {
    process.env = previousEnv
    removeSyntheticProviderFixture(fixture.root)
  })
  const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base')
  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node')
  const { createLangfuseExporter } = await import('../services/langfuseExporter.js')
  let received: { path: string | undefined; authorized: boolean; contentType: string | undefined; body: string } | undefined
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      received = { path: request.url, authorized: request.headers.authorization === `Basic ${Buffer.from('synthetic-public:synthetic-secret').toString('base64')}`,
        contentType: request.headers['content-type'], body }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const exporter = createLangfuseExporter({ host: `http://127.0.0.1:${address.port}`, publicKey: 'synthetic-public', secretKey: 'synthetic-secret' })
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  try {
    const span = provider.getTracer('synthetic-adapter-probe').startSpan('dependency-migration-probe')
    span.setAttribute('synthetic.flag', true)
    span.end()
    await provider.forceFlush()
    assert.ok(received, 'The loopback collector must receive the actual exporter request')
    assert.equal(received.path, '/api/public/otel/v1/traces')
    assert.equal(received.authorized, true)
    assert.match(received.contentType ?? '', /application\/json/)
    const payload = JSON.parse(received.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> }
    assert.equal(payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name, 'dependency-migration-probe')
  } finally {
    await provider.shutdown()
  }
})
