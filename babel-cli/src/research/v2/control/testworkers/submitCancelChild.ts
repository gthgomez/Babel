import { submitAdmittedOwnerCancelRequest } from '../storeCancelRequest.js'

const storeDirectory = process.argv[2]
const sessionId = process.argv[3]
if (!storeDirectory || !sessionId) {
  process.exit(2)
}

await submitAdmittedOwnerCancelRequest(storeDirectory, sessionId)
