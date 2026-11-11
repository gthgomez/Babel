/**
 * Private worker entry. The parent supplies anonymous inherited descriptors 3
 * (requests) and 4 (responses). Bypasses CLI environment/bootstrap so the
 * engine cannot load project credentials before its parent authenticates it.
 */
import { Socket } from 'node:net';

// Any later call to the ordinary environment bootstrap must treat credentials
// as already scoped by the native owner; never load a project/private .env.
process.env['BABEL_DESKTOP_IPC'] = '1';
process.env['BABEL_DESKTOP_CREDENTIALS_RESOLVED'] = '1';
const { startPrivateWorker } = await import('./privateWorker.js');

const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });
const worker = startPrivateWorker({ input, output });
const result = await worker.closed;
if (!result.settled) process.exitCode = 1;
