import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openAdmittedOwnerStore } from '../research/v2/control/researchStoreAdmission.js'
import type { ResearchModelPort } from '../research/v2/ports/researchModelPort.js'
import { runResearchV2DryRunPlan } from './researchV2Commands.js'

describe('research v2 CLI dry-run repair', () => {
  it('releases exclusive store lock when planning fails after owner open', async () => {
    const storeDirectory = await mkdtemp(join(tmpdir(), 'babel-research-v2-cli-repair-'))
    const failingModel: ResearchModelPort = {
      invokeStructured: async () => {
        throw new Error('injected planning failure')
      },
    }
    await assert.rejects(
      () =>
        runResearchV2DryRunPlan(
          { json: true },
          { storeDirectory, createModel: () => failingModel },
        ),
      /injected planning failure/,
    )
    const successor = await openAdmittedOwnerStore(storeDirectory)
    await successor.close()
  })
})
