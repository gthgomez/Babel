import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { admittedHttpGet, AdmittedNetworkPolicyError } from './admittedHttpGet.js'

describe('admittedHttpGet redirect admission', () => {
  it('denies private redirect before a second HTTP dispatch', async () => {
    let dispatchCount = 0
    await assert.rejects(
      () =>
        admittedHttpGet({
          url: 'https://93.184.216.34/start',
          maxBytes: 1024,
          signal: new AbortController().signal,
          env: { BABEL_WEB_ALLOW_PRIVATE: undefined },
          dispatchGet: async () => {
            dispatchCount += 1
            return {
              status: 302,
              headers: { location: 'http://127.0.0.1/private' },
              body: { buffer: Buffer.alloc(0), bytesReceived: 0, truncated: false },
            }
          },
        }),
      AdmittedNetworkPolicyError,
    )
    assert.equal(dispatchCount, 1)
  })
})
