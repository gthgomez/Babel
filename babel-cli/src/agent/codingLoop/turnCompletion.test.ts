import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildNoProgressStopMessage,
  decideTextOnlyTurnCompletion,
  isRepeatedNoProgressLoop,
  remainingAnswerChunk,
} from './turnCompletion.js';

describe('decideTextOnlyTurnCompletion', () => {
  test('Case A: final text with no tools and no writes completes the turn', () => {
    const d = decideTextOnlyTurnCompletion({
      hadToolCallsThisIteration: false,
      hasAnyWrites: false,
    });
    assert.equal(d.kind, 'complete');
  });

  test('Case B: clarification question is still a text-only complete', () => {
    const d = decideTextOnlyTurnCompletion({
      hadToolCallsThisIteration: false,
      hasAnyWrites: false,
    });
    assert.equal(d.kind, 'complete');
    assert.equal(d.reason, 'text_only_no_progress');
  });

  test('Case D: refusal / inability is a text-only complete', () => {
    const d = decideTextOnlyTurnCompletion({
      hadToolCallsThisIteration: false,
      hasAnyWrites: false,
    });
    assert.equal(d.kind, 'complete');
  });

  test('after tools this iteration, honesty / further evaluation may run', () => {
    const d = decideTextOnlyTurnCompletion({
      hadToolCallsThisIteration: true,
      hasAnyWrites: false,
    });
    assert.equal(d.kind, 'evaluate_further');
    assert.equal(d.reason, 'had_tools');
  });

  test('writes present: do not short-circuit honesty gate', () => {
    const d = decideTextOnlyTurnCompletion({
      hadToolCallsThisIteration: false,
      hasAnyWrites: true,
    });
    assert.equal(d.kind, 'evaluate_further');
    assert.equal(d.reason, 'has_writes');
  });
});

describe('remainingAnswerChunk', () => {
  test('streaming prefixes then full answer yields no extra chunk', () => {
    assert.equal(
      remainingAnswerChunk("I'm ready to help.", "I'm ready to help."),
      null,
    );
  });

  test('partial stream yields only the unsent suffix', () => {
    assert.equal(remainingAnswerChunk("I'm ", "I'm ready to help."), 'ready to help.');
  });

  test('no stream yet yields the full answer', () => {
    assert.equal(remainingAnswerChunk('', 'Here is the answer.'), 'Here is the answer.');
  });

  test('replacement frames do not replay the whole answer', () => {
    assert.equal(remainingAnswerChunk('Hello world!!!', 'Hello'), null);
  });
});

describe('isRepeatedNoProgressLoop', () => {
  test('stops after two consecutive no-progress text iterations', () => {
    assert.equal(
      isRepeatedNoProgressLoop({ consecutiveTextOnlyIterations: 2 }),
      true,
    );
    assert.equal(
      isRepeatedNoProgressLoop({ consecutiveTextOnlyIterations: 1 }),
      false,
    );
  });

  test('stops on repeated identical answers', () => {
    assert.equal(
      isRepeatedNoProgressLoop({
        consecutiveTextOnlyIterations: 0,
        consecutiveIdenticalAnswers: 2,
      }),
      true,
    );
  });

  test('stop message names the iteration count', () => {
    assert.match(buildNoProgressStopMessage(3), /3 iterations/);
  });
});
