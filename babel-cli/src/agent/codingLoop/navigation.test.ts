import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { attachMatchContext, buildBoundedRepoMap, formatSearchHits } from './navigation.js'

describe('navigation surface (shipped helpers)', () => {
  test('search hits include file, line, match, context, and truncation', () => {
    const lines = ['alpha', 'const needle = 1', 'omega']
    const ctx = attachMatchContext(lines, 2, 1)
    const text = formatSearchHits(
      [
        {
          file: 'src/a.ts',
          line: 2,
          match: 'const needle = 1',
          contextBefore: ctx.contextBefore,
          contextAfter: ctx.contextAfter,
        },
      ],
      { truncated: true, total: 40 },
    )
    assert.match(text, /src\/a\.ts:2: const needle = 1/)
    assert.match(text, /1:alpha/)
    assert.match(text, /3:omega/)
    assert.match(text, /1 shown of 40/)
  })

  test('bounded repo map lists dirs, config, tests, symbols', () => {
    const map = buildBoundedRepoMap({
      topDirs: ['src/', 'tests/'],
      keyFiles: ['package.json', 'tsconfig.json'],
      testHints: ['tests/a.test.ts'],
      entrypoints: ['src/index.ts'],
      symbols: ['ChatEngine.run'],
    })
    assert.match(map, /Repository Map/)
    assert.match(map, /package\.json/)
    assert.match(map, /tests\/a\.test\.ts/)
    assert.match(map, /ChatEngine\.run/)
  })
})
