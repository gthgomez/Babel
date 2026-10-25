import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { startJourneyService } from './harness-journey-service.js'

test('real source service records the bytes actually accessed and one-shot unavailability', async () => {
  const text = 'Aspen version 2 requires 6 GiB.\n'
  const service = await startJourneyService({ sources: { 'aspen-v2': text }, unavailableOnce: ['aspen-v2'] })
  try {
    assert.match(service.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await fetch(`${service.baseUrl}/sources/aspen-v2`)).status, 503)
    const response = await fetch(`${service.baseUrl}/sources/aspen-v2`)
    assert.equal(await response.text(), text)
    assert.equal(service.snapshot().sourceReads[0]?.sha256, createHash('sha256').update(text).digest('hex'))
    assert.equal((await fetch(`${service.baseUrl}/sources/unknown`)).status, 404)
  } finally { await service.close() }
})

test('exact record update has authoritative readback and adjacent record preservation', async () => {
  const service = await startJourneyService({ sources: {} })
  try {
    const response = await fetch(`${service.baseUrl}/records/demo-42`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-operation-id': 'update-42' }, body: JSON.stringify({ status: 'reviewed' }) })
    assert.equal(response.status, 200)
    assert.equal(z.object({ status: z.string() }).parse(await (await fetch(`${service.baseUrl}/records/demo-42`)).json()).status, 'reviewed')
    assert.equal(z.object({ status: z.string() }).parse(await (await fetch(`${service.baseUrl}/records/demo-43`)).json()).status, 'new')
    assert.equal(service.snapshot().writes[0]?.operationId, 'update-42')
    const copy = service.snapshot()
    copy.records['demo-43']!.status = 'forged'
    assert.equal(service.snapshot().records['demo-43']?.status, 'new')
  } finally { await service.close() }
})

test('lost reply after commit reconciles one actual create by stable identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-journey-service-'))
  const statePath = join(dir, 'service-state.json')
  const service = await startJourneyService({ sources: {}, dropFirstCreateReply: true, statePath })
  try {
    await assert.rejects(fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-operation-id': 'followup-42' }, body: JSON.stringify({ caseId: 'demo-42' }) }))
    assert.equal(service.snapshot().followups.length, 1)
    const reconciled = z.object({ id: z.string() }).parse(await (await fetch(`${service.baseUrl}/operations/followup-42`)).json())
    assert.equal(reconciled.id, service.snapshot().followups[0]?.id)
    assert.equal(service.snapshot().createAttempts, 1)
    assert.equal(service.snapshot().lookups[0]?.operationId, 'followup-42')
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(saved.followups.length, 1)
    assert.equal(saved.writes[0].reply, 'lost')
    assert.ok(saved.lookups[0].sequence > saved.writes[0].sequence)
  } finally { await service.close() }
})

test('duplicate identity cannot create another effect or change the committed payload', async () => {
  const service = await startJourneyService({ sources: {} })
  const post = (caseId: string) => fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-operation-id': 'stable-key' }, body: JSON.stringify({ caseId }) })
  try {
    assert.equal((await post('demo-42')).status, 201)
    assert.equal((await post('demo-42')).status, 200)
    assert.equal((await post('demo-43')).status, 409)
    assert.equal(service.snapshot().followups.length, 1)
    assert.equal(service.snapshot().createAttempts, 3)
  } finally { await service.close() }
})

test('malformed, unbound and oversized requests create no effects; shutdown is owned and idempotent', async () => {
  const service = await startJourneyService({ sources: {} })
  try {
    assert.equal((await fetch(`${service.baseUrl}/records/demo-42`, { method: 'PATCH', body: '{"status":"reviewed"}' })).status, 400)
    assert.equal((await fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'x-operation-id': 'bad' }, body: '{bad json' })).status, 400)
    assert.equal((await fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'x-operation-id': 'large' }, body: 'x'.repeat(20_000) })).status, 413)
    assert.equal(service.snapshot().writes.length, 0)
  } finally { await service.close(); await service.close() }
  await assert.rejects(fetch(`${service.baseUrl}/records/demo-42`))
})
