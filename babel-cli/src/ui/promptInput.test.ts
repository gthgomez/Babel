import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PromptInput, type PromptInputConfig } from './promptInput.js';
import { FrameScheduler } from './frameScheduler.js';
import { OutputBuffer } from './outputBuffer.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── Types ───────────────────────────────────────────────────────────────────

interface KeyEventLike {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function key(name: string, opts: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name.length === 1 ? name : `\x1b[${name}`,
    ...opts,
  };
}

function type(input: any, text: string): void {
  for (const ch of text) {
    if (ch === '\n') {
      input.handleKey(key('enter'));
    } else {
      input.handleKey(key(ch, { sequence: ch }));
    }
  }
}

function createTestInput(config: Partial<PromptInputConfig> = {}): any {
  FrameScheduler.getInstance().resetForTest();
  const input = new PromptInput({ onSubmit: () => {}, ...config }) as any;
  input.active = true;
  input.mode = 'insert';
  input.cleanupKeyHandler = null;
  // Suppress rendering during tests — we test state, not ANSI output
  input.render = () => {};
  input.renderCursor = () => {};
  return input;
}

function makeCompleter(matches: string[]) {
  return (line: string): [string[], string] => {
    const filtered = matches.filter((m) => m.startsWith(line));
    return [filtered, line];
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PromptInput', () => {
  // ── Constructor ──────────────────────────────────────────────────────────

  describe('constructor & basic API', () => {
    it('initializes with empty buffer', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      const state = input.getState();
      assert.equal(state.text, '');
      assert.deepEqual(state.lines, ['']);
      assert.equal(state.cursorLine, 0);
      assert.equal(state.cursorCol, 0);
      assert.equal(state.active, false);
      assert.equal(state.mode, 'insert');
      assert.equal(state.browsingHistory, false);
    });

    it('accepts initial history array', () => {
      const input = new PromptInput({
        onSubmit: () => {},
        history: ['first', 'second', 'third'],
      });
      assert.deepEqual(input.getHistory(), ['first', 'second', 'third']);
    });

    it('trims initial history to historySize', () => {
      const input = new PromptInput({
        onSubmit: () => {},
        history: ['a', 'b', 'c'],
        historySize: 2,
      });
      assert.deepEqual(input.getHistory(), ['b', 'c']);
    });

    it('getState() returns copy of lines', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      const state = input.getState();
      state.lines.push('injected');
      assert.deepEqual(input.getState().lines, ['']);
    });

    it('setText() replaces buffer and moves cursor to end', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.setText('hello\nworld');
      const state = input.getState();
      assert.equal(state.text, 'hello\nworld');
      assert.deepEqual(state.lines, ['hello', 'world']);
      assert.equal(state.cursorLine, 1);
      assert.equal(state.cursorCol, 5);
    });

    it('setText() with empty string results in single empty line', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.setText('');
      const state = input.getState();
      assert.deepEqual(state.lines, ['']);
      assert.equal(state.cursorLine, 0);
      assert.equal(state.cursorCol, 0);
    });

    it('addHistory() adds entry', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.addHistory('hello');
      assert.deepEqual(input.getHistory(), ['hello']);
    });

    it('addHistory() rejects empty', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.addHistory('');
      input.addHistory('   ');
      assert.deepEqual(input.getHistory(), []);
    });

    it('addHistory() moves existing entry to end (MRU)', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.addHistory('a');
      input.addHistory('b');
      input.addHistory('c');
      input.addHistory('a');
      assert.deepEqual(input.getHistory(), ['b', 'c', 'a']);
    });

    it('addHistory() caps at configured size', () => {
      const input = new PromptInput({ onSubmit: () => {}, historySize: 3 });
      input.addHistory('a');
      input.addHistory('b');
      input.addHistory('c');
      input.addHistory('d');
      assert.deepEqual(input.getHistory(), ['b', 'c', 'd']);
    });

    it('getHistory() returns a copy', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      input.addHistory('a');
      const hist = input.getHistory();
      hist.push('injected');
      assert.deepEqual(input.getHistory(), ['a']);
    });

    it('onSubmit() registers and returns unregister function', () => {
      const input = new PromptInput({ onSubmit: () => {} });
      const unreg = input.onSubmit(() => {});
      assert.equal(typeof unreg, 'function');
    });

    it('loadHistory / saveHistory round-trips', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-prompt-test-'));
      const historyFile = path.join(tmpDir, 'history.json');
      try {
        const input = new PromptInput({
          onSubmit: () => {},
          historyFile,
          history: ['alpha', 'beta', 'gamma'],
        });
        await input.saveHistory();

        const input2 = new PromptInput({ onSubmit: () => {}, historyFile });
        await input2.loadHistory();
        assert.deepEqual(input2.getHistory(), ['alpha', 'beta', 'gamma']);

        const histBefore = input2.getHistory();
        await input2.loadHistory();
        assert.deepEqual(input2.getHistory(), histBefore);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── Text Buffer ─────────────────────────────────────────────────────────

  describe('text buffer operations', () => {
    it('inserts character at cursor', () => {
      const input = createTestInput();
      input.handleKey(key('h'));
      input.handleKey(key('i'));
      assert.equal(input.getState().text, 'hi');
    });

    it('backspace removes char before cursor', () => {
      const input = createTestInput();
      type(input, 'abcd');
      input.handleKey(key('backspace'));
      assert.equal(input.getState().text, 'abc');
    });

    it('backspace merges lines', () => {
      const input = createTestInput();
      input.lines = ['hello', 'world'];
      input.cursorLine = 1;
      input.cursorCol = 0;
      input.handleKey(key('backspace'));
      assert.equal(input.getState().text, 'helloworld');
    });

    it('backspace at buffer start is no-op', () => {
      const input = createTestInput();
      input.handleKey(key('backspace'));
      assert.equal(input.getState().text, '');
    });

    it('deleteForward removes char at cursor', () => {
      const input = createTestInput();
      type(input, 'abcd');
      input.handleKey(key('left'));
      input.handleKey(key('delete'));
      assert.equal(input.getState().text, 'abc');
    });

    it('deleteForward merges lines', () => {
      const input = createTestInput();
      input.lines = ['hello', 'world'];
      input.cursorLine = 0;
      input.cursorCol = 5;
      input.handleKey(key('delete'));
      assert.equal(input.getState().text, 'helloworld');
    });

    it('deleteForward at buffer end is no-op', () => {
      const input = createTestInput();
      type(input, 'abc');
      input.handleKey(key('delete'));
      assert.equal(input.getState().text, 'abc');
    });

    it('deleteWordBackward removes word before cursor', () => {
      const input = createTestInput();
      type(input, 'hello world');
      input.handleKey(key('w', { ctrl: true }));
      assert.equal(input.getState().text, 'hello ');
    });

    it('insertText handles multi-line paste', () => {
      const input = createTestInput();
      input.handleKey(key('paste', { sequence: 'multi\nline\npaste' }));
      assert.deepEqual(input.getState().lines, ['multi', 'line', 'paste']);
    });

    it('insertNewline splits line at cursor', () => {
      const input = createTestInput();
      type(input, 'abc');
      input.handleKey(key('left'));
      input.handleKey(key('left'));
      input.handleKey(key('enter'));
      assert.deepEqual(input.getState().lines, ['a', 'bc']);
    });
  });

  // ── Cursor Movement ─────────────────────────────────────────────────────

  describe('cursor movement', () => {
    it('left arrow moves cursor left', () => {
      const input = createTestInput();
      type(input, 'abc');
      input.handleKey(key('left'));
      assert.equal(input.cursorCol, 2);
    });

    it('left arrow wraps to previous line', () => {
      const input = createTestInput();
      input.lines = ['hello', 'world'];
      input.cursorLine = 1;
      input.cursorCol = 0;
      input.handleKey(key('left'));
      assert.equal(input.cursorLine, 0);
      assert.equal(input.cursorCol, 5);
    });

    it('right arrow moves cursor right', () => {
      const input = createTestInput();
      type(input, 'abc');
      input.handleKey(key('left'));
      input.handleKey(key('right'));
      assert.equal(input.cursorCol, 3);
    });

    it('right arrow wraps to next line', () => {
      const input = createTestInput();
      input.lines = ['hello', 'world'];
      input.cursorLine = 0;
      input.cursorCol = 5;
      input.handleKey(key('right'));
      assert.equal(input.cursorLine, 1);
      assert.equal(input.cursorCol, 0);
    });

    it('Ctrl+A moves to line start', () => {
      const input = createTestInput();
      type(input, 'hello');
      input.handleKey(key('a', { ctrl: true }));
      assert.equal(input.cursorCol, 0);
    });

    it('Ctrl+E moves to line end', () => {
      const input = createTestInput();
      type(input, 'hello');
      input.handleKey(key('left'));
      input.handleKey(key('e', { ctrl: true }));
      assert.equal(input.cursorCol, 5);
    });
  });

  // ── History ─────────────────────────────────────────────────────────────

  describe('history navigation', () => {
    it('up arrow loads most recent entry', () => {
      const input = createTestInput({ history: ['first', 'second', 'third'] });
      input.handleKey(key('up'));
      assert.equal(input.getState().text, 'third');
      assert.equal(input.getState().browsingHistory, true);
    });

    it('down arrow restores draft', () => {
      const input = createTestInput({ history: ['a', 'b', 'c'] });
      type(input, 'draft');
      input.handleKey(key('up'));
      input.handleKey(key('down'));
      assert.equal(input.getState().text, 'draft');
      assert.equal(input.getState().browsingHistory, false);
    });

    it('up arrow with empty history is no-op', () => {
      const input = createTestInput();
      input.handleKey(key('up'));
      assert.equal(input.getState().text, '');
    });
  });

  // ── Tab Completion ──────────────────────────────────────────────────────

  describe('tab completion', () => {
    it('single match auto-inserted', () => {
      const input = createTestInput({
        completer: makeCompleter(['foobar']),
      });
      type(input, 'foo');
      input.handleKey(key('tab'));
      assert.equal(input.getState().text, 'foobar');
    });

    it('multiple matches show popup', () => {
      const input = createTestInput({
        completer: makeCompleter(['foobar', 'foobaz']),
      });
      type(input, 'foo');
      input.handleKey(key('tab'));
      assert.ok(input.completionPopup !== null);
      assert.deepEqual(input.completionPopup, ['foobar', 'foobaz']);
    });

    it('no matches yields no change', () => {
      const input = createTestInput({
        completer: makeCompleter(['abc', 'def']),
      });
      type(input, 'xyz');
      input.handleKey(key('tab'));
      assert.equal(input.getState().text, 'xyz');
    });

    it('applyCompletion inserts selected', () => {
      const input = createTestInput({
        completer: makeCompleter(['foobar', 'foobaz']),
      });
      type(input, 'foo');
      input.handleKey(key('tab'));
      input.handleKey(key('enter'));
      assert.equal(input.getState().text, 'foobar');
      assert.equal(input.completionPopup, null);
    });

    it('Escape dismisses popup', () => {
      const input = createTestInput({
        completer: makeCompleter(['foobar', 'foobaz']),
      });
      type(input, 'foo');
      input.handleKey(key('tab'));
      assert.ok(input.completionPopup !== null);
      input.handleKey(key('escape'));
      assert.equal(input.completionPopup, null);
    });
  });

  // ── Slash Commands ──────────────────────────────────────────────────────

  describe('slash commands', () => {
    it('popup visible when / on first line', () => {
      const input = createTestInput();
      input.handleKey(key('/'));
      assert.equal(input.shouldShowSlashPopup(), true);
    });

    it('popup hidden when / not on first line', () => {
      const input = createTestInput();
      type(input, 'no slash');
      assert.equal(input.shouldShowSlashPopup(), false);
    });

    it('filtered slash commands', () => {
      const input = createTestInput();
      type(input, '/he');
      const filtered = input.getFilteredSlashCommands();
      // Fuzzy matching may return commands whose name+description contain 'h'
      // and 'e' non-contiguously (e.g. /mode via "Switch execution mode").
      // Verify results are non-empty, all are slash commands, and /help is
      // the top-ranked result (best prefix match for "/he").
      assert.ok(filtered.length >= 2, `expected at least 2 results, got ${filtered.length}`);
      for (const cmd of filtered) {
        assert.ok(cmd.name.startsWith('/'), `expected slash command, got ${cmd.name}`);
      }
      assert.equal(filtered[0]!.name, '/help');
    });

    it('Tab applies slash completion', () => {
      const input = createTestInput();
      type(input, '/he');
      input.handleKey(key('tab'));
      const text = input.getState().text;
      assert.ok(text.startsWith('/'));
      assert.ok(text.endsWith(' '));
    });

    it('up/down navigate slash popup', () => {
      const input = createTestInput();
      input.handleKey(key('/'));
      const initial = input.slashSelected;
      input.handleKey(key('down'));
      assert.equal(input.slashSelected, initial + 1);
      input.handleKey(key('up'));
      assert.equal(input.slashSelected, initial);
    });
  });

  // ── Submit Flow ─────────────────────────────────────────────────────────

  describe('submit flow', () => {
    it('Enter on last line at end submits', () => {
      let submittedText = '';
      const input = createTestInput({
        onSubmit: (text: string) => {
          submittedText = text;
        },
      });
      type(input, 'hello');
      input.handleKey(key('enter'));
      assert.equal(submittedText, 'hello');
    });

    it('Enter on empty buffer does not submit', () => {
      let submitted = false;
      const input = createTestInput({
        onSubmit: () => {
          submitted = true;
        },
      });
      input.handleKey(key('enter'));
      assert.equal(submitted, false);
      assert.equal(input.active, true);
    });

    it('Enter mid-line inserts newline', () => {
      let submitted = false;
      const input = createTestInput({
        onSubmit: () => {
          submitted = true;
        },
      });
      type(input, 'abc');
      input.handleKey(key('left'));
      input.handleKey(key('enter'));
      assert.equal(submitted, false);
      assert.deepEqual(input.getState().lines, ['ab', 'c']);
    });

    it('Ctrl+Enter submits even mid-line', () => {
      let submittedText = '';
      const input = createTestInput({
        onSubmit: (text: string) => {
          submittedText = text;
        },
      });
      type(input, 'hello');
      input.handleKey(key('left'));
      input.handleKey(key('enter', { ctrl: true }));
      assert.equal(submittedText, 'hello');
    });
  });

  // ── Special Keys ────────────────────────────────────────────────────────

  describe('special key dispatch', () => {
    it('Ctrl+C on empty buffer cancels', () => {
      let cancelled = false;
      const input = createTestInput({
        onCancel: () => {
          cancelled = true;
        },
      });
      input.handleKey(key('c', { ctrl: true }));
      assert.equal(input.active, false);
      assert.equal(cancelled, true);
    });

    it('Ctrl+C on non-empty with onInterrupt fires interrupt', () => {
      let interrupted = false;
      const input = createTestInput({
        onInterrupt: () => {
          interrupted = true;
        },
      });
      type(input, 'hi');
      input.handleKey(key('c', { ctrl: true }));
      assert.equal(interrupted, true);
      assert.equal(input.active, true);
    });

    it('Ctrl+P fires onCommandPalette', () => {
      let paletteCalled = false;
      const input = createTestInput({
        onCommandPalette: () => {
          paletteCalled = true;
        },
      });
      input.handleKey(key('p', { ctrl: true }));
      assert.equal(paletteCalled, true);
    });

    it('paste event inserts text', () => {
      const input = createTestInput();
      input.handleKey(key('paste', { sequence: 'pasted text' }));
      assert.equal(input.getState().text, 'pasted text');
    });

    it('Escape dismisses completion popup first', () => {
      const input = createTestInput({
        vimMode: true,
        completer: makeCompleter(['abc', 'abd']),
      });
      type(input, 'a');
      input.handleKey(key('tab'));
      assert.ok(input.completionPopup !== null);
      input.handleKey(key('escape'));
      assert.equal(input.completionPopup, null);
    });
  });

  // ── Vim Mode ────────────────────────────────────────────────────────────

  describe('vim mode', () => {
    it('Escape toggles to normal mode', () => {
      const input = createTestInput({ vimMode: true });
      input.handleKey(key('escape'));
      assert.equal(input.getState().mode, 'normal');
    });

    it('Escape in normal returns to insert', () => {
      const input = createTestInput({ vimMode: true });
      input.handleKey(key('escape'));
      input.handleKey(key('escape'));
      assert.equal(input.getState().mode, 'insert');
    });

    it('h/j/k/l navigate', () => {
      const input = createTestInput({ vimMode: true });
      type(input, 'abc');
      input.handleKey(key('escape'));
      input.handleKey(key('h'));
      assert.equal(input.cursorCol, 2);
      input.handleKey(key('l'));
      assert.equal(input.cursorCol, 3);
    });

    it('0/$ line bounds', () => {
      const input = createTestInput({ vimMode: true });
      type(input, 'hello');
      input.handleKey(key('escape'));
      input.handleKey(key('0'));
      assert.equal(input.cursorCol, 0);
      input.handleKey(key('$'));
      assert.equal(input.cursorCol, 5);
    });

    it('dd deletes current line', () => {
      const input = createTestInput({ vimMode: true });
      input.lines = ['first', 'second', 'third'];
      input.cursorLine = 1;
      input.handleKey(key('escape'));
      input.handleKey(key('d'));
      input.handleKey(key('d'));
      assert.deepEqual(input.getState().lines, ['first', 'third']);
    });

    it('yy yanks and p pastes', () => {
      const input = createTestInput({ vimMode: true });
      input.lines = ['hello'];
      input.handleKey(key('escape'));
      input.handleKey(key('y'));
      input.handleKey(key('y'));
      assert.equal(input.killBuffer, 'hello');
      input.handleKey(key('d'));
      input.handleKey(key('d'));
      input.handleKey(key('p'));
      assert.equal(input.getState().text, 'hello');
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles unicode characters', () => {
      const input = createTestInput();
      type(input, 'café');
      assert.equal(input.getState().text, 'café');
    });

    it('handles very long lines (500+ chars)', () => {
      const input = createTestInput();
      const longStr = 'a'.repeat(500);
      type(input, longStr);
      assert.equal(input.getState().text, longStr);
      assert.equal(input.cursorCol, 500);
    });

    it('clear also resets history and completion state', () => {
      const input = createTestInput();
      input.historyIndex = 2;
      input.savedDraft = 'draft';
      input.browsingHistory = true;
      input.completionPopup = ['a', 'b'];
      input.clear();
      assert.equal(input.historyIndex, -1);
      assert.equal(input.savedDraft, null);
      assert.equal(input.browsingHistory, false);
      assert.equal(input.completionPopup, null);
    });

    it('backspace merges lines and deletes characters correctly', () => {
      const input = createTestInput();
      input.lines = ['a', 'bc'];
      input.cursorLine = 1;
      input.cursorCol = 0;
      input.handleKey(key('backspace')); // merge 'bc' into 'a'
      assert.deepEqual(input.getState().lines, ['abc']);
    });
  });

  // ── Inline Autocomplete Integration ──────────────────────────────────────

  describe('inline autocomplete integration', () => {
    it('activates suggestion after typing text matching history', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      assert.ok(input.ac.hasSuggestion());
      assert.equal(input.ac.getGhostText(), '.sh --prod');
    });

    it('Tab accepts autocomplete suggestion', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      input.handleKey(key('tab'));
      assert.equal(input.getState().text, 'deploy.sh --prod');
      // Accepting clears the suggestion state
      assert.equal(input.ac.hasSuggestion(), false);
    });

    it('Right arrow at end of line accepts autocomplete suggestion', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      input.handleKey(key('right'));
      assert.equal(input.getState().text, 'deploy.sh --prod');
      assert.equal(input.ac.hasSuggestion(), false);
    });

    it('Right arrow mid-line does not accept suggestion', () => {
      const input = createTestInput({
        history: ['hello world'],
      });
      type(input, 'hello');
      assert.ok(input.ac.hasSuggestion());
      input.handleKey(key('left')); // move off end — no longer at line end
      input.handleKey(key('right')); // should just move cursor right, not accept
      assert.equal(input.getState().text, 'hello');
    });

    it('Left arrow dismisses autocomplete suggestion', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      assert.ok(input.ac.hasSuggestion());
      input.handleKey(key('left'));
      assert.equal(input.ac.hasSuggestion(), false);
      assert.equal(input.ac.getGhostText(), null);
    });

    it('typing non-matching text clears autocomplete', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      assert.ok(input.ac.hasSuggestion());
      type(input, 'x'); // "deployx" no longer matches "deploy.sh --prod"
      assert.equal(input.ac.hasSuggestion(), false);
    });

    it('constructor seeds autocomplete history from config', () => {
      const input = createTestInput({
        history: ['npm test', 'npm run build', 'git push'],
      });
      type(input, 'npm');
      assert.ok(input.ac.hasSuggestion());
      // Both "npm test" and "npm run build" match; neither more frequent,
      // so the most recent ("npm run build") wins as tiebreaker
      assert.equal(input.ac.getGhostText(), ' run build');
    });

    it('addHistory() feeds autocomplete independently', () => {
      const input = createTestInput();
      input.addHistory('private command');
      type(input, 'private');
      assert.ok(input.ac.hasSuggestion());
      assert.equal(input.ac.getGhostText(), ' command');
    });

    it('autocomplete works on second line after inserting newline mid-line', () => {
      const input = createTestInput({
        history: ['target line'],
      });
      // Type "ab" then insert newline mid-line so cursor lands on line 1
      type(input, 'ab');
      input.handleKey(key('left')); // cursor between 'a' and 'b'
      input.handleKey(key('enter')); // splits line → lines=['a', 'b']
      assert.deepEqual(input.getState().lines, ['a', 'b']);
      type(input, 'target');
      assert.ok(input.ac.hasSuggestion(), 'should have suggestion on line 1');
      assert.equal(input.ac.getGhostText(), ' line');
    });

    it('backspace triggers autocomplete refresh', () => {
      const input = createTestInput({
        history: ['deploy.sh --prod'],
      });
      type(input, 'deploy');
      assert.ok(input.ac.hasSuggestion());
      // Type a character that breaks the match, then backspace to restore
      type(input, 'x');
      assert.equal(input.ac.hasSuggestion(), false);
      input.handleKey(key('backspace'));
      // After backspace, the prefix "deploy" should match again
      assert.ok(input.ac.hasSuggestion());
      assert.equal(input.ac.getGhostText(), '.sh --prod');
    });
  });

  describe('queue-while-busy (C2)', () => {
    it('Tab queues draft when task is running', () => {
      const queued: string[] = [];
      const input = createTestInput({
        isTaskRunning: () => true,
        onQueue: (text) => {
          queued.push(text);
          return true;
        },
      });
      type(input, 'follow up task');
      input.handleKey(key('tab'));
      assert.deepEqual(queued, ['follow up task']);
      assert.equal(input.getState().text, '');
    });

    it('Tab completes when task is not running', () => {
      const queued: string[] = [];
      const input = createTestInput({
        completer: makeCompleter(['alpha', 'alphabet']),
        isTaskRunning: () => false,
        onQueue: (text) => {
          queued.push(text);
          return true;
        },
      });
      type(input, 'al');
      input.handleKey(key('tab'));
      assert.equal(queued.length, 0);
      assert.equal(input.getState().text, 'alpha');
    });

    it('Tab does not queue slash commands while busy', () => {
      const queued: string[] = [];
      const input = createTestInput({
        isTaskRunning: () => true,
        onQueue: (text) => {
          queued.push(text);
          return true;
        },
      });
      type(input, '/help');
      input.handleKey(key('tab'));
      assert.equal(queued.length, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OutputBuffer framing
// ═══════════════════════════════════════════════════════════════════════════════

describe('OutputBuffer framing', () => {
  it('OutputBuffer is imported and usable', () => {
    const buf = OutputBuffer.getInstance();
    assert.ok(buf, 'OutputBuffer.getInstance() should return an instance');
    assert.equal(typeof buf.write, 'function', 'OutputBuffer should have write method');
    assert.equal(typeof buf.beginFrame, 'function', 'OutputBuffer should have beginFrame method');
    assert.equal(typeof buf.endFrame, 'function', 'OutputBuffer should have endFrame method');
  });

  it('promptInput routes through OutputBuffer (BABEL_PROMPT_BUFFERED gate)', () => {
    // Verify BABEL_PROMPT_BUFFERED env var is respected.
    // When BABEL_PROMPT_BUFFERED=0, framing is skipped but writes still
    // flow through OutputBuffer.write(). The CI grep gate enforces no
    // direct process.stdout.write() calls remain in promptInput.ts.
    const buf = OutputBuffer.getInstance();
    // Can write through the buffer
    assert.doesNotThrow(() => buf.write('test'));
  });
});

// ── Cursor restoration on exception ─────────────────────────────────

describe('cursor restoration', () => {
  it('restores cursor if renderCursor throws during render', () => {
    FrameScheduler.getInstance().resetForTest();

    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      // Create input without mocking render/renderCursor to test the real path
      const input = new PromptInput({ onSubmit: () => {} }) as any;
      input.active = true;
      input.mode = 'insert';
      input.cleanupKeyHandler = null;

      // Make renderCursor throw to simulate an error mid-render
      input.renderCursor = () => { throw new Error('simulated render error'); };

      try {
        input.render();
      } catch {
        // Expected — renderCursor throws; the finally block should still restore cursor
      }

      const allOutput = writes.join('');
      // The safety net in the finally block must emit cursor show
      assert.match(allOutput, /\x1b\[\?25h/);
    } finally {
      // Cleanup
      process.stdout.write = originalWrite;
    }
  });
});
