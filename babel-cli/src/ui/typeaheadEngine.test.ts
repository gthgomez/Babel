import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TypeaheadEngine,
  filterSlashCommands,
  BUILTIN_SLASH_COMMANDS,
} from './typeaheadEngine.js';

function ctx(
  lines: string[],
  cursorLine = 0,
  cursorCol = lines[cursorLine]?.length ?? 0,
): { lines: string[]; cursorLine: number; cursorCol: number; active: boolean } {
  return { lines, cursorLine, cursorCol, active: true };
}

describe('filterSlashCommands', () => {
  it('filters by command name prefix', () => {
    const hits = filterSlashCommands('/th');
    assert.ok(hits.some((c) => c.name === '/theme'));
    assert.ok(!hits.some((c) => c.name === '/help'));
  });

  it('returns all commands for bare slash', () => {
    assert.equal(filterSlashCommands('/').length, BUILTIN_SLASH_COMMANDS.length);
  });
});

describe('TypeaheadEngine', () => {
  it('activates slash mode on line 0', () => {
    const engine = new TypeaheadEngine();
    const { state } = engine.sync(ctx(['/hel'], 0, 4));
    assert.equal(state.mode, 'slash');
    assert.ok(state.items.length > 0);
    assert.equal(state.popupPlacement, 'above');
  });

  it('mention mode takes priority over slash on same line', () => {
    const engine = new TypeaheadEngine();
    const { state, mentionQuery } = engine.sync(ctx(['@src'], 0, 4));
    assert.equal(state.mode, 'mention');
    assert.equal(mentionQuery, 'src');
    assert.equal(state.popupPlacement, 'below');
  });

  it('accepts slash selection', () => {
    const engine = new TypeaheadEngine();
    engine.sync(ctx(['/hel'], 0, 4));
    const result = engine.accept(ctx(['/hel'], 0, 4));
    assert.ok(result);
    assert.equal(result!.mode, 'slash');
    assert.equal(result!.insertText, '/help ');
  });

  it('accepts mention selection', () => {
    const engine = new TypeaheadEngine();
    engine.sync(ctx(['see @ui'], 0, 7));
    engine.setMentionResults([
      {
        type: 'file',
        label: 'src/ui/sanitize.ts',
        description: 'sanitize',
        insertText: 'src/ui/sanitize.ts',
        score: 10,
      },
    ]);
    const result = engine.accept(ctx(['see @ui'], 0, 7));
    assert.ok(result);
    assert.equal(result!.mode, 'mention');
    assert.equal(result!.insertText, 'src/ui/sanitize.ts');
    assert.equal(result!.startCol, 4);
    assert.equal(result!.endCol, 7);
  });

  it('completer popup activates when set', () => {
    const engine = new TypeaheadEngine();
    engine.sync(ctx(['abc'], 0, 3));
    engine.setCompleterPopup(['/help', '/theme']);
    assert.equal(engine.getMode(), 'completer');
    assert.equal(engine.getViewState().items.length, 2);
  });

  it('moveSelection changes slash index', () => {
    const engine = new TypeaheadEngine();
    engine.sync(ctx(['/'], 0, 1));
    engine.moveSelection(1);
    assert.equal(engine.getViewState().selectedIndex, 1);
  });

  it('slash prefix filter uses preferPrefix — "/he" finds "/help" before loose matches', () => {
    // Without the old substring post-filter, preferPrefix ensures that "/help"
    // (whose name starts with "he") ranks above "/mode" (which could match
    // out-of-order via 'h' in "chat" and 'e' in "execution").
    const hits = filterSlashCommands('/he');
    assert.ok(hits.some((c) => c.name === '/help'));
    // /help should be the first result (prefix match boosted)
    assert.equal(hits[0]!.name, '/help');
  });

  it('slash prefix filter with deep prefix matching', () => {
    const hits = filterSlashCommands('/th');
    assert.ok(hits.some((c) => c.name === '/theme'));
    // /theme should rank first since "th" is a prefix of "theme"
    assert.equal(hits[0]!.name, '/theme');
  });
});