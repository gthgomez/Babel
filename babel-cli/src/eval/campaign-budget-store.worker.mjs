import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { CampaignBudgetStore } = await import(pathToFileURL(join(here, 'campaign-budget-store.ts')).href)

const [statePath] = process.argv.slice(2)
const store = new CampaignBudgetStore({
  statePath,
  campaignId: 'pilot',
  limitMicroUsd: 10_000,
})

const GO_TIMEOUT_MS = 10_000

if (typeof process.send !== 'function') {
  console.error('campaign-budget-store worker requires IPC fork')
  process.exit(1)
}

process.send({ type: 'ready' })

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker go barrier timeout after ${GO_TIMEOUT_MS}ms`))
    }, GO_TIMEOUT_MS)
    process.on('message', (message) => {
      if (message?.type === 'go') {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
  })
  await store.transactAsync((budget) => {
    budget.reserve('async-op', 100)
  })
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
