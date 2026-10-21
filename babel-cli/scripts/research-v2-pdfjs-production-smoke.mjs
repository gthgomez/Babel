#!/usr/bin/env node
/**
 * Production dependency smoke: pdfjs-dist legacy entry + @napi-rs/canvas (DOMMatrix).
 * Run after `npm ci --omit=dev --omit=optional` in babel-cli.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

await import('@napi-rs/canvas')

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
assert.equal(typeof pdfjs.getDocument, 'function', 'pdfjs-dist legacy build must export getDocument')

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/research/v2/adapters/documents/fixtures/two-page-sample.pdf',
)
const data = new Uint8Array(readFileSync(fixture))
const task = pdfjs.getDocument({ data, useSystemFonts: true })
const doc = await task.promise
assert.equal(doc.numPages, 2)
const page = await doc.getPage(1)
const text = await page.getTextContent()
const joined = text.items.map((item) => item.str).join(' ')
assert.match(joined, /Page/i)
await doc.destroy()

console.log('research-v2-pdfjs-production-smoke: ok')
