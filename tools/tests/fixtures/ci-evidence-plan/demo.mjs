// Generate explicitly synthetic inputs and a bounded public historical sample.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fixture, historicalRetryFixture, portabilityFixture, pin } from './fixture.mjs'

if (process.argv.length !== 3) throw new Error('Provide an output directory for demo JSON')
const directory = resolve(process.argv[2])
mkdirSync(directory, { recursive: true })
for (const [name, create] of [['same-head', fixture], ['portability', portabilityFixture], ['historical-retry', historicalRetryFixture]]) {
  const { evidence, context } = create(), pinned = pin(context)
  writeFileSync(join(directory, `${name}.evidence.json`), JSON.stringify(evidence, null, 2) + '\n')
  writeFileSync(join(directory, `${name}.context.json`), pinned.bytes)
  writeFileSync(join(directory, `${name}.context.sha256`), pinned.expectedSha256 + '\n')
}
console.log('Wrote three demo input/context pairs; pins are demonstration values, not authenticated trust.')
