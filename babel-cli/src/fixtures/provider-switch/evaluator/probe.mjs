// Execution adapter only. The parent owns expected values and verdict authority.
// Process separation/resource bounds are not an OS security sandbox.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const input = JSON.parse(readFileSync(0, 'utf8'))
const { total } = await import(pathToFileURL(process.argv[2]).href)
const results = [total()]
const preserved = []
for (const entries of input.cases) {
  const before = JSON.stringify(entries)
  results.push(total(entries))
  preserved.push(JSON.stringify(entries) === before)
  results.push(total(entries))
}
results.push(total())
process.stdout.write(JSON.stringify({ nonce: input.nonce, results, preserved }))
