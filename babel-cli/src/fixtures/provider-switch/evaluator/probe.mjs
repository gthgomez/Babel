// Execution adapter only. The parent owns expected values and verdict authority.
// Process separation/resource bounds are not an OS security sandbox.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const input = JSON.parse(readFileSync(0, 'utf8'))
// Capture protocol operations and input snapshots before loading the candidate.
// Native JSON.stringify still invokes hostile toJSON hooks on objects, so only
// primitive numbers/strings are encoded below. Containers never enter stringify.
const stringify = JSON.stringify
const write = process.stdout.write.bind(process.stdout)
const finite = Number.isFinite
const equal = isDeepStrictEqual
const snapshots = input.cases.map(entries => structuredClone(entries))
let results = ''
let preserved = ''
const append = (value) => {
  if (typeof value !== 'number' || !finite(value)) throw new Error('total must return a finite number')
  results += (results ? ',' : '') + stringify(value)
}
const { total } = await import(pathToFileURL(process.argv[2]).href)
append(total())
for (let i = 0; i < input.cases.length; i++) {
  const entries = input.cases[i]
  append(total(entries))
  const firstPreserved = equal(entries, snapshots[i])
  append(total(entries))
  preserved += (i ? ',' : '') + (firstPreserved && equal(entries, snapshots[i]) ? 'true' : 'false')
}
append(total())
write('{"nonce":' + stringify(input.nonce) + ',"results":[' + results + '],"preserved":[' + preserved + ']}')
