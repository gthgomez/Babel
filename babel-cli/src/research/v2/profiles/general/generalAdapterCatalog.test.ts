import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generalAdapterCatalog } from './generalAdapterCatalog.js'

test('generalAdapterCatalog: exposes document and web adapter ids for A registry', () => {
  assert.match(generalAdapterCatalog.document.adapterId, /^general-document\//)
  assert.match(generalAdapterCatalog.web.adapterId, /^general-web\//)
  assert.equal(typeof generalAdapterCatalog.document.factory, 'function')
  assert.equal(typeof generalAdapterCatalog.web.factory, 'function')
})
