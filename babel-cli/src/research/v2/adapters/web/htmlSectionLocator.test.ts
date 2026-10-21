import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allocateSectionLocatorId } from './htmlSectionLocator.js'

test('allocateSectionLocatorId: disambiguates repeated headings', () => {
  const map = new Map<string, number>()
  const a = allocateSectionLocatorId('Overview', map)
  const b = allocateSectionLocatorId('Overview', map)
  assert.equal(a, 'overview')
  assert.equal(b, 'overview~2')
})

test('allocateSectionLocatorId: non-ascii headings get stable unique slugs', () => {
  const map = new Map<string, number>()
  const a = allocateSectionLocatorId('日本語', map)
  const b = allocateSectionLocatorId('日本語', map)
  assert.match(a, /^heading-[a-f0-9]{16}$/)
  assert.equal(b, `${a}~2`)
})
