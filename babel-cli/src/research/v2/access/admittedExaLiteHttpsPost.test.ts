import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { describe, it } from 'node:test'
import {
  admittedExaLiteHttpsPost,
  defaultAdmittedExaLiteHttpsPostDispatch,
  EXA_LITE_API_HOSTNAME,
} from './admittedExaLiteHttpsPost.js'
import { assertPublicNetworkTarget, type PublicNetworkTarget } from './admittedHttpGet.js'
import { ExaLiteOperationDeadlineError } from './exaLiteOperationAbort.js'
import { setExaLiteHttpsRequestForTests, type ExaLiteHttpsRequestFn } from './exaLiteHttpsClient.js'

function stubHttpsRequest(onResponse: (res: IncomingMessage) => void): ExaLiteHttpsRequestFn {
  const fn = (_url: string | URL, _options: unknown, callback?: (res: IncomingMessage) => void) => {
    const res = new EventEmitter() as IncomingMessage
    res.statusCode = 200
    onResponse(res)
    callback?.(res)
    const req = new EventEmitter() as ClientRequest
    Object.assign(req, {
      write: () => req,
      end: () => req,
      setTimeout: () => req,
      destroy: () => {
        req.emit('error', new Error('destroyed'))
        return req
      },
    })
    return req
  }
  return fn as ExaLiteHttpsRequestFn
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

  it('aborts trickling default HTTPS body when linked deadline expires', async () => {
    let reqDestroyed = false
    setExaLiteHttpsRequestForTests(
      ((_url, _options, callback) => {
        const res = new EventEmitter() as IncomingMessage
        res.statusCode = 200
        let trickle: NodeJS.Timeout | undefined
        res.destroy = () => {
          if (trickle) clearInterval(trickle)
          res.removeAllListeners()
          return res
        }
        callback?.(res)
        const req = new EventEmitter() as ClientRequest
        Object.assign(req, {
          write: () => req,
          end: () => {
            trickle = setInterval(() => res.emit('data', Buffer.from('x')), 25)
            return req
          },
          setTimeout: () => req,
          destroy: () => {
            reqDestroyed = true
            res.destroy()
            req.emit('error', new Error('destroyed'))
            return req
          },
        })
        return req
      }) as ExaLiteHttpsRequestFn,
    )
    try {
      await assert.rejects(
        () =>
          admittedExaLiteHttpsPost({
            apiKey: 'k',
            jsonBody: { type: 'lite', query: 'q' },
            signal: new AbortController().signal,
            timeoutMs: 50,
            env: { BABEL_WEB_ALLOW_PRIVATE: '1' },
          }),
        ExaLiteOperationDeadlineError,
      )
      assert.equal(reqDestroyed, true)
    } finally {
      setExaLiteHttpsRequestForTests(null)
    }
  })

  it('settles promptly when admission never resolves, then consumes late resolution without dispatch', async () => {
    let dispatchCalled = false
    let resolveAdmission!: (target: PublicNetworkTarget) => void
    const admissionPending = new Promise<PublicNetworkTarget>((resolve) => {
      resolveAdmission = resolve
    })
    const started = Date.now()
    await assert.rejects(
      () =>
        admittedExaLiteHttpsPost({
          apiKey: 'k',
          jsonBody: { type: 'lite', query: 'q' },
          signal: new AbortController().signal,
          timeoutMs: 40,
          env: { BABEL_WEB_ALLOW_PRIVATE: '1' },
          admissionTargetResolver: () => admissionPending,
          dispatch: async () => {
            dispatchCalled = true
            return { status: 200, headers: {}, bodyText: '{"results":[]}' }
          },
        }),
      ExaLiteOperationDeadlineError,
    )
    assert.ok(Date.now() - started < 120, 'public await must not wait on pending admission')
    assert.equal(dispatchCalled, false)
    resolveAdmission(
      await assertPublicNetworkTarget(
        new URL(`https://${EXA_LITE_API_HOSTNAME}/search`),
        { BABEL_WEB_ALLOW_PRIVATE: '1' },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(dispatchCalled, false)
  })
})
