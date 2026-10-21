import { submitAdmittedOwnerCancelRequest } from '../storeCancelRequest.js'

const storeDirectory = process.argv[2]
const sessionId = process.argv[3]
if (!storeDirectory || !sessionId) {
  throw new Error('submitCancelChild: store directory and session id arguments required')
}

await submitAdmittedOwnerCancelRequest(storeDirectory, sessionId)
