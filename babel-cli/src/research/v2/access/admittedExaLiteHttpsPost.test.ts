import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { ClientRequest } from 'node:https'
import { describe, it } from 'node:test'
import {
  admittedExaLiteHttpsPost,
  defaultAdmittedExaLiteHttpsPostDispatch,
  EXA_LITE_API_HOSTNAME,
} from './admittedExaLiteHttpsPost.js'
import { assertPublicNetworkTarget } from './admittedHttpGet.js'
import { setExaLiteHttpsRequestForTests } from './exaLiteHttpsClient.js'

function stubHttpsRequest(
  onResponse: (res: IncomingMessage) => void,
): typeof import('node:https').request {
  return (_url, _options, callback) => {
    const res = new EventEmitter() as IncomingMessage
    res.statusCode = 200
    onResponse(res)
    callback?.(res)
    const req = new EventEmitter() as ClientRequest
    req.write = () => true
    req.end = () => true
    req.setTimeout = () => req
    req.destroy = () => req
    return req
  }
}

describe('admittedExaLiteHttpsPost default transport', () => {
  it('defaultAdmittedExaLiteHttpsPostDispatch accepts object params (not positional args)', async () => {
    let calls = 0
    setExaLiteHttpsRequestForTests(
      stubHttpsRequest((res) => {
        calls += 1
        setImmediate(() => {
          res.emit('data', Buffer.from('{"results":[]}'))
          res.emit('end')
        })
      }),
    )
    try {
      const url = new URL(`https://${EXA_LITE_API_HOSTNAME}/search`)
      const target = await assertPublicNetworkTarget(url, { BABEL_WEB_ALLOW_PRIVATE: '1' })
      const result = await defaultAdmittedExaLiteHttpsPostDispatch({
        url,
        target,
        headers: { 'x-api-key': 'test-key' },
        body: '{"type":"lite"}',
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        maxBytes: 1024,
      })
      assert.equal(calls, 1)
      assert.equal(result.status, 200)
      assert.match(result.bodyText, /results/)
    } finally {
      setExaLiteHttpsRequestForTests(null)
    }
  })

  it('destroys response when body exceeds maxBytes', async () => {
    let destroyed = false
    setExaLiteHttpsRequestForTests(
      stubHttpsRequest((res) => {
        res.destroy = () => {
          destroyed = true
          res.removeAllListeners()
          return res
        }
        setImmediate(() => {
          res.emit('data', Buffer.alloc(48))
          res.emit('data', Buffer.alloc(48))
        })
      }),
    )
    const url = new URL(`https://${EXA_LITE_API_HOSTNAME}/search`)
    const target = await assertPublicNetworkTarget(url, { BABEL_WEB_ALLOW_PRIVATE: '1' })
    try {
      await assert.rejects(
        () =>
          defaultAdmittedExaLiteHttpsPostDispatch({
            url,
            target,
            headers: {},
            body: '{}',
            signal: new AbortController().signal,
            timeoutMs: 5_000,
            maxBytes: 64,
          }),
        /maxBytes/,
      )
      assert.equal(destroyed, true)
    } finally {
      setExaLiteHttpsRequestForTests(null)
    }
  })

  it('admittedExaLiteHttpsPost enforces total deadline across DNS + HTTPS (injected dispatch)', async () => {
    const result = await admittedExaLiteHttpsPost({
      apiKey: 'k',
      jsonBody: { type: 'lite', query: 'q' },
      signal: new AbortController().signal,
      timeoutMs: 50,
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ results: [] }),
        }
      },
    })
    assert.equal(result.ok, true)
  })
})
