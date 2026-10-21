import { readFile } from 'node:fs/promises'
import {
  InMemoryResearchStore,
  type InMemoryResearchStoreSnapshot,
} from '../fixtures/fakePorts.js'
import { DurableStoreSnapshotError } from './durableStoreErrors.js'
import { assertSnapshotIntegrity } from './snapshotIntegrity.js'

export async function loadStoreInnerFromSnapshotFile(
  snapshotPath: string,
): Promise<InMemoryResearchStore> {
  try {
    const raw = await readFile(snapshotPath, 'utf8')
    const parsed = JSON.parse(raw) as InMemoryResearchStoreSnapshot
    assertSnapshotIntegrity(parsed)
    return InMemoryResearchStore.restoreSnapshot(parsed)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      return new InMemoryResearchStore()
    }
    if (err instanceof SyntaxError) {
      throw new DurableStoreSnapshotError('snapshot is not valid JSON')
    }
    throw err
  }
}
