/**
 * H6 exit-gate: runtime-generated golden episode through a real ChatEngine
 * controller + real workspace (mock model runner, no external API).
 *
 * One-command verification:
 *   cd babel-cli && npx tsx --test src/agent/episodeReplay.liveGolden.test.ts
 */

import * as assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runLiveControllerGoldenEpisode,
  validateGoldenEpisode,
  replayTerminalDecision,
  projectCrossSurfaceFacts,
  type GoldenEpisodeArtifact,
} from './episodeReplay.js';
import { parseSessionEventLog } from './sessionEvents.js';
import { terminalOutcomeExitCode } from '../schemas/agentContracts.js';
import { userFacingStatusFromOutcome } from '../cli/userFacingStatus.js';

describe('H6 live controller golden episode', () => {
  let workspace: string;
  let outDir: string;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), 'babel-h6-live-ws-'));
    writeFileSync(join(workspace, 'hello.txt'), 'hello golden world\n', 'utf-8');
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'h6-live-golden', private: true }, null, 2),
      'utf-8',
    );
    outDir = join(workspace, '.babel-golden');
  });

  after(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('one command: ChatEngine + real workspace → live_runtime golden + model-free replay', async () => {
    const result = await runLiveControllerGoldenEpisode({
      workspace_path: workspace,
      out_dir: outDir,
      task: 'Read hello.txt and finish',
      user_message: 'Please inspect hello.txt then complete',
      sequence: 'tools_then_complete',
    });

    assert.ok(
      result.ok,
      `live golden failed: ${result.errors.join('; ')} kinds=${result.session_event_kinds.join(',')}`,
    );
    assert.strictEqual(result.live_runtime, true);
    assert.strictEqual(result.controller, 'chat');
    assert.ok(existsSync(result.artifact_path), 'artifact must exist on disk');

    // Controller-produced events (not empty hand-built log)
    assert.ok(result.session_event_kinds.includes('user_submitted'));
    assert.ok(
      result.session_event_kinds.includes('turn_ended') ||
        result.session_event_kinds.includes('completion_decision'),
    );
    assert.ok(result.thread_event_kinds.includes('assistant_tool_calls'));
    assert.ok(result.thread_event_kinds.includes('tool_result'));

    // Artifact provenance
    const raw = JSON.parse(readFileSync(result.artifact_path, 'utf-8')) as GoldenEpisodeArtifact;
    assert.strictEqual(raw.live_runtime, true);
    assert.strictEqual(raw.controller, 'chat');
    assert.ok(raw.workspace_path.includes(workspace) || raw.workspace_path.length > 0);

    // Model-free replay reaches same terminal
    assert.ok(result.replay_matches);
    const log = parseSessionEventLog(raw.session_events_jsonl);
    const replay = replayTerminalDecision(log);
    assert.strictEqual(replay.invented, false);
    assert.strictEqual(String(replay.outcome), raw.expected_terminal);

    // Cross-surface agreement via live mappers
    assert.ok(result.cross_surface_agree);
    const facts = projectCrossSurfaceFacts(log, {
      exitCodeForOutcome: (o) =>
        terminalOutcomeExitCode(o as import('../schemas/agentContracts.js').TerminalOutcome),
      userFacingStatus: (o) =>
        userFacingStatusFromOutcome(o as import('../schemas/agentContracts.js').TerminalOutcome),
    });
    assert.ok(facts.agree);
    assert.strictEqual(facts.headless_json.outcome, facts.persistence.outcome);

    // Validation API
    const v = validateGoldenEpisode(raw);
    assert.ok(v.ok, v.errors.join('; '));
  });

  it('complete-only path still produces controller terminal events and valid golden', async () => {
    const result = await runLiveControllerGoldenEpisode({
      workspace_path: workspace,
      out_dir: join(workspace, '.babel-golden-complete'),
      task: 'Answer briefly',
      user_message: 'Say done',
      sequence: 'complete',
    });
    assert.ok(
      result.session_event_kinds.includes('user_submitted'),
      result.errors.join('; '),
    );
    assert.ok(result.artifact_path.endsWith('live-golden-episode.json'));
    const raw = JSON.parse(readFileSync(result.artifact_path, 'utf-8')) as GoldenEpisodeArtifact;
    assert.strictEqual(raw.live_runtime, true);
    const v = validateGoldenEpisode(raw);
    assert.ok(v.ok, v.errors.join('; '));
  });

  it('restores benchmark approval when initially absent or preconfigured', async () => {
    const previous = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    try {
      delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
      await runLiveControllerGoldenEpisode({
        workspace_path: workspace,
        out_dir: join(workspace, '.babel-golden-env-absent'),
        sequence: 'complete',
      });
      assert.strictEqual(process.env['BABEL_BENCHMARK_AUTO_APPROVE'], undefined);

      process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = 'operator-value';
      await runLiveControllerGoldenEpisode({
        workspace_path: workspace,
        out_dir: join(workspace, '.babel-golden-env-present'),
        sequence: 'complete',
      });
      assert.strictEqual(process.env['BABEL_BENCHMARK_AUTO_APPROVE'], 'operator-value');
    } finally {
      if (previous === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
      else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = previous;
    }
  });
});
