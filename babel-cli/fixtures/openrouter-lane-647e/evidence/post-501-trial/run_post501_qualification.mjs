#!/usr/bin/env node
/** @deprecated Use: npm run test:openrouter-lane-647e-preflight -- --live --trial post-501 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const preflight = join(packageRoot, 'scripts', 'run_openrouter_lane_qualification.mjs')
const result = spawnSync(process.execPath, [preflight, '--live', '--trial', 'post-501'], {
  stdio: 'inherit',
  cwd: packageRoot,
  env: process.env,
})
process.exit(result.status ?? 1)
