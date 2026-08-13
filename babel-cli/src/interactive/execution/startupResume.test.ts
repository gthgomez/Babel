import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatResumeHint,
  shouldForceResumePicker,
} from '../repl/startupResumeHint.js';

describe('startup resume — no forced picker', () => {
  it('does not require a modal on the default path', () => {
    const prevPicker = process.env['BABEL_RESUME_PICKER'];
    const prevSkip = process.env['BABEL_SKIP_RESUME_PICKER'];
    delete process.env['BABEL_RESUME_PICKER'];
    delete process.env['BABEL_SKIP_RESUME_PICKER'];
    try {
      assert.equal(shouldForceResumePicker(), false);
    } finally {
      if (prevPicker !== undefined) process.env['BABEL_RESUME_PICKER'] = prevPicker;
      else delete process.env['BABEL_RESUME_PICKER'];
      if (prevSkip !== undefined) process.env['BABEL_SKIP_RESUME_PICKER'] = prevSkip;
      else delete process.env['BABEL_SKIP_RESUME_PICKER'];
    }
  });

  it('hints last session with an explicit /resume command', () => {
    const hint = formatResumeHint({
      id: 'interactive_20260812_120000',
      mtimeMs: Date.now() - 5 * 60_000,
      preview: 'fix the retry leak',
    });
    assert.match(hint, /\/resume interactive_20260812_120000/);
    assert.match(hint, /last session/);
    assert.doesNotMatch(hint, /Enter # to resume/);
  });

  it('opt-in picker remains available', () => {
    const prev = process.env['BABEL_RESUME_PICKER'];
    process.env['BABEL_RESUME_PICKER'] = '1';
    try {
      assert.equal(shouldForceResumePicker(), true);
    } finally {
      if (prev !== undefined) process.env['BABEL_RESUME_PICKER'] = prev;
      else delete process.env['BABEL_RESUME_PICKER'];
    }
  });
});
