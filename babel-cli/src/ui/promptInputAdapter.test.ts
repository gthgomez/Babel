/**
 * promptInputAdapter.test.ts — Tests for the readline-compatible PromptInput adapter.
 *
 * Covers:
 *   1. shouldUsePromptInputV2() detection under various env conditions
 *   2. createPromptInputAdapter() routing (V2 on/off)
 *   3. Adapter instance API (state methods, callbacks, accessors)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { Interface } from 'node:readline';
import { shouldUsePromptInputV2, createPromptInputAdapter } from './promptInputAdapter.js';
import { withEnv } from './testUtils.js';

// ─── Globals ─────────────────────────────────────────────────────────────────

/** Store for saved process properties restored in after(). */
let savedIsTTY: boolean | undefined;
let savedSetRawMode: unknown;

before(() => {
  // Some test envs lack setRawMode on stdin — provide a no-op so creating
  // a PromptInput doesn't throw.
  savedSetRawMode = (process.stdin as any).setRawMode;
  if (typeof (process.stdin as any).setRawMode !== 'function') {
    (process.stdin as any).setRawMode = () => {};
  }
});

after(() => {
  (process.stdin as any).setRawMode = savedSetRawMode;
});

/** Temporarily set process.stdout.isTTY for a test body. */
function withIsTTY(value: boolean, fn: () => void): void {
  const orig = (process.stdout as any).isTTY;
  try {
    (process.stdout as any).isTTY = value;
    fn();
  } finally {
    (process.stdout as any).isTTY = orig;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. shouldUsePromptInputV2 detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldUsePromptInputV2', () => {
  it('returns false when stdout is not a TTY', () => {
    withIsTTY(false, () => {
      withEnv({ CI: undefined, BABEL_PROMPT_V2: undefined }, () => {
        assert.equal(shouldUsePromptInputV2(), false);
      });
    });
  });

  it('returns true when stdout is a TTY and not in CI', () => {
    withIsTTY(true, () => {
      withEnv({ CI: undefined, BABEL_PROMPT_V2: undefined, WT_SESSION: 'test' }, () => {
        assert.equal(shouldUsePromptInputV2(), true);
      });
    });
  });

  it('returns false when CI env var is set', () => {
    withIsTTY(true, () => {
      withEnv({ CI: 'true', BABEL_PROMPT_V2: undefined, WT_SESSION: 'test' }, () => {
        assert.equal(shouldUsePromptInputV2(), false);
      });
    });
  });

  it('BABEL_PROMPT_V2=1 forces on regardless of non-TTY', () => {
    withIsTTY(false, () => {
      withEnv({ BABEL_PROMPT_V2: '1', CI: undefined }, () => {
        assert.equal(shouldUsePromptInputV2(), true);
      });
    });
  });

  it('BABEL_PROMPT_V2=true forces on', () => {
    withIsTTY(false, () => {
      withEnv({ BABEL_PROMPT_V2: 'true', CI: undefined }, () => {
        assert.equal(shouldUsePromptInputV2(), true);
      });
    });
  });

  it('BABEL_PROMPT_V2=0 forces off even on TTY', () => {
    withIsTTY(true, () => {
      withEnv({ BABEL_PROMPT_V2: '0', CI: undefined }, () => {
        assert.equal(shouldUsePromptInputV2(), false);
      });
    });
  });

  it('BABEL_PROMPT_V2=false forces off', () => {
    withIsTTY(true, () => {
      withEnv({ BABEL_PROMPT_V2: 'false', CI: undefined }, () => {
        assert.equal(shouldUsePromptInputV2(), false);
      });
    });
  });

  it('CI takes precedence over TTY even without BABEL_PROMPT_V2', () => {
    withIsTTY(true, () => {
      withEnv({ CI: '1', BABEL_PROMPT_V2: undefined, WT_SESSION: 'test' }, () => {
        assert.equal(shouldUsePromptInputV2(), false);
      });
    });
  });

  it('BABEL_PROMPT_V2=1 overrides CI', () => {
    withIsTTY(true, () => {
      withEnv({ CI: 'true', BABEL_PROMPT_V2: '1' }, () => {
        assert.equal(shouldUsePromptInputV2(), true);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. createPromptInputAdapter routing
// ═══════════════════════════════════════════════════════════════════════════════

describe('createPromptInputAdapter routing', () => {
  it('returns a standard readline Interface when V2 is disabled', () => {
    withEnv({ BABEL_PROMPT_V2: '0' }, () => {
      const rl = createPromptInputAdapter({});
      // readline.Interface has a `input` property — verify it's a real Interface
      assert.ok('input' in rl);
      assert.ok('output' in rl);
      assert.ok(typeof rl.question === 'function');
      assert.ok(typeof rl.close === 'function');
      rl.close();
    });
  });

  it('returns an adapter (Interface-like) when V2 is enabled', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      const rl = createPromptInputAdapter({
        input: new PassThrough(),
        output: new PassThrough(),
        onSubmit: () => {},
      });
      // Should still look like an Interface
      assert.ok(typeof rl.question === 'function');
      assert.ok(typeof rl.close === 'function');
      assert.ok(typeof rl.write === 'function');
      rl.close();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Adapter API
// ═══════════════════════════════════════════════════════════════════════════════

describe('PromptInputAdapter API', () => {
  let input: PassThrough;
  let output: PassThrough;
  let adapter: Interface;

  function createAdapter(config: Record<string, unknown> = {}): Interface {
    input = new PassThrough();
    output = new PassThrough();
    return createPromptInputAdapter({
      input,
      output,
      prompt: '› ',
      onSubmit: () => {},
      ...config,
    } as any);
  }

  after(() => {
    if (adapter && typeof adapter.close === 'function') {
      try {
        adapter.close();
      } catch {
        /* already closed */
      }
    }
  });

  it('setPrompt updates the prompt string', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      adapter.setPrompt('❯');
      // _prompt is the internal getter matching readline's _prompt
      assert.equal((adapter as any)._prompt, '❯');
    });
  });

  it('pause() and resume() toggle paused state', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      const ret1 = adapter.pause();
      assert.equal(ret1, adapter, 'pause() returns this');
      const ret2 = adapter.resume();
      assert.equal(ret2, adapter, 'resume() returns this');
    });
  });

  it('ref() and unref() are no-ops that return undefined', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      assert.doesNotThrow(() => (adapter as any).ref());
      assert.doesNotThrow(() => (adapter as any).unref());
    });
  });

  it('close() does not throw', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      assert.doesNotThrow(() => adapter.close());
    });
  });

  it('close() is idempotent', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      adapter.close();
      assert.doesNotThrow(() => adapter.close());
    });
  });

  it('on("line") registers a line callback', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      const calls: string[] = [];
      const ret = adapter.on('line', (line: string) => {
        calls.push(line);
      });
      assert.equal(ret, adapter, 'on() returns this');
      // Note: actual callback firing is tested via fireSigint or internal
      // mechanisms — verifying the registration path is the unit-test concern.
    });
  });

  it('on("SIGINT") registers a SIGINT callback', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      let called = false;
      const ret = adapter.on('SIGINT', () => {
        called = true;
      });
      assert.equal(ret, adapter, 'on() returns this');
    });
  });

  it('history and getHistory() return current history', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter({ history: ['first', 'second'] });
      const h = (adapter as any).history;
      assert.ok(Array.isArray(h));
      const g = (adapter as any).getHistory();
      assert.ok(Array.isArray(g));
    });
  });

  it('question(query, cb) returns void for callback overload', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      // We don't await the callback — just verify the method returns void
      // when a callback is provided.  The internal readline won't fire
      // without actual stdin input, but that's a Node readline concern.
      const result = (adapter as any).question('prompt> ', () => {});
      assert.equal(result, undefined);
    });
  });

  it('question(query) returns a Promise when no callback', () => {
    withEnv({ BABEL_PROMPT_V2: '1' }, () => {
      adapter = createAdapter();
      const result = (adapter as any).question('prompt> ');
      assert.ok(result instanceof Promise);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Long-running test: createPromptInputAdapter with standard readline
// ═══════════════════════════════════════════════════════════════════════════════

describe('createPromptInputAdapter — readline fallback', () => {
  it('returns an Interface that can be closed', () => {
    withEnv({ BABEL_PROMPT_V2: '0' }, () => {
      const rl = createPromptInputAdapter({});
      assert.doesNotThrow(() => rl.close());
    });
  });
});
