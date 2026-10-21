#!/usr/bin/env node
/**
 * Production dependency smoke: direct pdfjs-dist legacy entry (B PDF adapter contract).
 * Run after `npm install --omit=dev` in babel-cli.
 */
import assert from 'node:assert/strict'

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
assert.equal(typeof pdfjs.getDocument, 'function', 'pdfjs-dist legacy build must export getDocument')
console.log('research-v2-pdfjs-production-smoke: ok')
