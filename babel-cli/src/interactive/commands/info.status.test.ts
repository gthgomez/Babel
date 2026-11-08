import assert from 'node:assert/strict'
import test from 'node:test'
import { handleStatus } from './info.js'

test('status shows running product identity and configured route', () => {
  const prior = console.log; const output: string[] = []
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(' ')) }
  try {
    handleStatus({ state: { mode: 'chat', router: 'v9', model: 'glm-5.3-flash' }, verboseMode: false } as never, [])
    const text = output.join('\n')
    assert.match(text, /Babel/); assert.match(text, /revision unknown/i)
    assert.match(text, /Package/); assert.match(text, /Entry/); assert.match(text, /openrouter/i)
  } finally { console.log = prior }
})
