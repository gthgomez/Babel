import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openAdmittedOwnerStore } from '../researchStoreAdmission.js'

const storeDirectory = process.argv[2]
if (!storeDirectory) {
  process.exit(2)
}

const owner = await openAdmittedOwnerStore(storeDirectory)
await writeFile(join(storeDirectory, '.child-owner-session'), owner.sessionId, 'utf8')
process.exit(0)
