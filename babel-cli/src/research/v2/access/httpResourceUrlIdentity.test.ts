import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { httpResourceDedupKey, httpResourceUrlWithoutFragment } from './httpResourceUrlIdentity.js'

describe('httpResourceUrlIdentity', () => {
  it('strips fragments for dedup keys', () => {
    const base = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    assert.equal(httpResourceUrlWithoutFragment(`${base}#a`), base)
    assert.equal(httpResourceDedupKey(`${base}#a`), httpResourceDedupKey(`${base}#b`))
  })

  it('preserves path and query while removing hash only', () => {
    const withQuery = 'https://example.com/doc?x=1#section'
    assert.equal(httpResourceUrlWithoutFragment(withQuery), 'https://example.com/doc?x=1')
  })
})
