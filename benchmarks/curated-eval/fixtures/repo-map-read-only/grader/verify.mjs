import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const referenceReport = {
  request_flow: [
    'src/api/charge-route.mjs',
    'src/auth/tenant-policy.mjs',
    'src/billing/charges.mjs',
  ],
  authorization_module: 'src/auth/tenant-policy.mjs',
  billing_export: 'chargeInvoice',
  test_file: 'test/charge-route.test.mjs',
  cross_tenant_result: { status: 403, code: 'TENANT_MISMATCH' },
}

export async function writeReference(workspace) {
  const reportPath = path.join(workspace, 'reports', 'architecture.json')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(reportPath), { recursive: true }))
  await import('node:fs/promises').then(({ writeFile }) => writeFile(reportPath, `${JSON.stringify(referenceReport, null, 2)}\n`))
}

export async function verify(workspace) {
  try {
    const report = JSON.parse(await readFile(path.join(workspace, 'reports', 'architecture.json'), 'utf8'))
    assert.deepEqual(report, referenceReport, 'report must identify the real request, authorization, billing, and test path')
    const route = await import(pathToFileURL(path.join(workspace, 'src/api/charge-route.mjs')).href + `?grader=${Date.now()}`)
    const denied = route.postCharge({
      tenantId: 'tenant-a',
      invoice: { id: 'private-invoice', tenantId: 'tenant-b', items: [{ amountCents: 99 }] },
    })
    assert.deepEqual(denied, { status: 403, code: 'TENANT_MISMATCH' }, 'reported security boundary must match executable behavior')
    const testSource = await readFile(path.join(workspace, 'test/charge-route.test.mjs'), 'utf8')
    assert.match(testSource, /another tenant invoice/)
    return { status: 'passed', assertions: 3, errors: [] }
  } catch (error) {
    return { status: 'failed', assertions: 3, errors: [error.message] }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verify(path.resolve(process.argv[2] ?? '.'))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'passed') process.exitCode = 1
}
