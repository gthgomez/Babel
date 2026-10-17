import test from 'node:test';
import assert from 'node:assert/strict';
import { formatConversationThinkingStatus } from './conversationLiveness.js';
import { renderBackgroundTaskProgress, renderBackgroundTaskFooter } from './backgroundTaskProgress.js';
import { renderStatusBar } from './statusBar.js';
import { stripAnsi } from './theme.js';
import { composeThinkingHud } from './thinkingState.js';

test('primary progress labels response time and cancellation without claiming a stalled model', () => {
  const out = formatConversationThinkingStatus({ spinner: '◌', stallMs: 7000,
    snapshot: { elapsedMs: 7300, modelIdleMs: 6000, phase: 'investigate' } });
  const text = stripAnsi(out.indicator + ' ' + out.timer);
  assert.match(text, /Thinking.*investigate/);
  assert.match(text, /response 7s/);
  assert.match(text, /Ctrl\+C.*cancel/);
  assert.doesNotMatch(text, /idle/);
});

test('background indexing is scoped and indeterminate progress does not imply a percentage', () => {
  const tasks = [{ id: 'fixture', label: 'Indexing workspace', status: 'running' as const, elapsedMs: 6400 }];
  const text = stripAnsi(renderBackgroundTaskProgress(tasks, 80));
  assert.match(text, /Background.*Indexing workspace.*elapsed 6.4s/);
  assert.doesNotMatch(text, /░/);
  assert.match(stripAnsi(renderBackgroundTaskFooter(tasks, 80)), /Background/);
});

test('footer identifies session usage and unavailable active context', () => {
  const text = stripAnsi(renderStatusBar({ model: 'fixture', modelId: 'fixture-model', mode: 'chat', project: 'fixture',
    totalTokens: 2466, totalCost: 0.0003, turnCount: 1, width: 180 }));
  assert.match(text, /session 2,466 tok/);
  assert.match(text, /session est\. \$0.0003/);
  assert.match(text, /context unavailable/);
});

test('unknown charge prices never become a zero-cost session claim', () => {
  const text = stripAnsi(renderStatusBar({ model: 'fixture', mode: 'chat', project: 'fixture',
    totalTokens: 0, totalCost: 0, turnCount: 1, width: 180, hasUnknownCost: true }));
  assert.match(text, /session cost unavailable/);
  assert.doesNotMatch(text, /\$0.0000/);
});

test('cancel hint survives narrow activity layouts', () => {
  const hud = composeThinkingHud({ indicatorLine: 'Thinking… [investigate] (response 12s · Ctrl+C cancel)',
    overlayLines: ['Background: Indexing workspace'], columns: 40, previousOverlayLines: 0 });
  assert.match(stripAnsi(hud.output), /Ctrl\+C cancel/);
});
