import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { describe, it } from 'node:test'
import { admittedHttpGet } from './admittedHttpGet.js'
import { GOVERNED_HTTP_USER_AGENT } from './governedHttpClientIdentity.js'
import { acquisitionDiagnosticsFromHttpGet } from './sourceAcquisitionDiagnosticsFromHttp.js'

describe('admittedHttpGet default transport', () => {
  it('sends governed User-Agent and Accept on the actual Node HTTP request', async () => {
    let observedHeaders: Record<string, string | string[] | undefined> = {}
    const server = createHttpServer((req, res) => {
      observedHeaders = { ...req.headers }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    const url = `http://127.0.0.1:${port}/governed-get`
    try {
      const response = await admittedHttpGet({
        url,
        maxBytes: 1024,
        signal: new AbortController().signal,
        env: { BABEL_WEB_ALLOW_PRIVATE: '1' },
      })
      assert.equal(response.ok, true)
      const userAgent = observedHeaders['user-agent']
      assert.equal(userAgent, GOVERNED_HTTP_USER_AGENT)
      assert.equal(observedHeaders.accept, '*/*')
      assert.equal(observedHeaders.authorization, undefined)
    } finally {
      server.close()
    }
  })

  it('bounds sanitized http_failure metadata on non-2xx without retaining sensitive headers', async () => {
    const longMessage = `${'x'.repeat(600)}visible-tail`
    const body = JSON.stringify({
      message: longMessage,
      documentation_url: 'https://docs.github.com/rest',
    })
    let observedAuthorization: string | undefined
    const server = createHttpServer((req, res) => {
      observedAuthorization = req.headers.authorization
      res.writeHead(403, {
        'content-type': 'application/json',
        'x-github-request-id': 'GH-REQ-403-TEST',
        'retry-after': '12',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-resource': 'core',
        'set-cookie': 'ignored=secret',
      })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    const url = `http://127.0.0.1:${port}/forbidden`
    try {
      const response = await admittedHttpGet({
        url,
        maxBytes: 16_384,
        signal: new AbortController().signal,
        env: { BABEL_WEB_ALLOW_PRIVATE: '1' },
      })
      assert.equal(response.ok, false)
      assert.equal(response.status, 403)
      assert.equal(observedAuthorization, undefined)

      const diagnostics = acquisitionDiagnosticsFromHttpGet(response, {
        attemptedUrl: url,
        sourceId: 'src-github-tree',
      })
      assert.equal(diagnostics.http_status, 403)
      assert.ok(diagnostics.http_failure)
      assert.equal(diagnostics.http_failure?.request_id, 'GH-REQ-403-TEST')
      assert.equal(diagnostics.http_failure?.retry_after, '12')
      assert.equal(diagnostics.http_failure?.rate_limit_remaining, '0')
      assert.equal(diagnostics.http_failure?.rate_limit_reset, '1700000000')
      assert.equal(diagnostics.http_failure?.rate_limit_resource, 'core')
      const msg = diagnostics.http_failure?.public_message ?? ''
      assert.equal(msg.length, 512)
      assert.equal(msg, longMessage.slice(0, 512))
      assert.ok(!JSON.stringify(diagnostics).includes('set-cookie'))
      assert.ok(!JSON.stringify(diagnostics).includes('documentation_url'))
    } finally {
      server.close()
    }
  })
})
