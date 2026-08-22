/**
 * Batch #80 — semantic visual enforcement.
 *
 * Drives shipped theme / token-bar / review-card / renderer / tool-renderer
 * functions. Color meaning is asserted via the exported paint functions
 * (function identity), not hardcoded ANSI dumps. Glyphs remain the
 * non-color carrier so NO_COLOR stays distinguishable.
 *
 * Module-level HAS_COLOR is cached at import, so ANSI inequality is
 * exercised in a FORCE_COLOR child that loads the same production modules.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  error,
  warning,
  muted,
  info,
  success,
  accent,
  stripAnsi,
} from './theme.js';
import {
  UtilizationTier,
  classifyUtilization,
  utilizationColorFn,
  renderTokenBar,
  renderCompactTokenBar,
} from './tokenBar.js';
import {
  presentChatReview,
  reviewTitleTone,
  looksLikeVerifiedSuccess,
} from './reviewCard.js';
import { renderPlanModeWarning, renderErrorPanel } from './renderers.js';
import { ReadFileRenderer } from './toolRenderers.js';
import { renderToolExecutionTrail } from './toolPresentation.js';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(UI_DIR, '..', '..');

function runColored(source: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '3' };
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: PKG_ROOT,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('token-bar tiers do not reuse execution-error paint', () => {
  it('maps safe/moderate/high/critical to muted/info/warning/warning', () => {
    assert.equal(utilizationColorFn(UtilizationTier.Safe), muted);
    assert.equal(utilizationColorFn(UtilizationTier.Moderate), info);
    assert.equal(utilizationColorFn(UtilizationTier.High), warning);
    assert.equal(utilizationColorFn(UtilizationTier.Critical), warning);
  });

  it('does not assign error() to any utilization tier', () => {
    for (const tier of Object.values(UtilizationTier)) {
      assert.notEqual(
        utilizationColorFn(tier),
        error,
        `tier ${tier} must not share the execution-error channel`,
      );
    }
  });

  it('paints a critical percent with warning(), not error()', () => {
    const used = 190_000;
    const limit = 200_000;
    const { tier, percent } = classifyUtilization(used, limit);
    assert.equal(tier, UtilizationTier.Critical);
    assert.equal(percent, 95);
    const bar = renderTokenBar(used, limit);
    assert.match(stripAnsi(bar), /95%/);
    assert.match(stripAnsi(bar), /190k\/200k/);
    const child = runColored(`
      import { renderTokenBar } from './src/ui/tokenBar.ts';
      import { warning, error } from './src/ui/theme.ts';
      const bar = renderTokenBar(190000, 200000);
      const pct = '95%'.padStart(4);
      if (!bar.includes(warning(pct))) { console.error('missing warning paint'); process.exit(2); }
      if (warning(pct) === error(pct)) { console.error('color helpers collapsed'); process.exit(3); }
      if (bar.includes(error(pct))) { console.error('used error paint'); process.exit(4); }
      process.stdout.write('ok');
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(child.stdout, 'ok');
  });

  it('keeps unknown limits as ctx ? rather than a fabricated percent', () => {
    const bar = renderTokenBar(12_000, 0);
    const compact = renderCompactTokenBar(12_000, 0);
    assert.match(stripAnsi(bar), /ctx \?/);
    assert.equal(compact, '[ctx ?]');
    assert.doesNotMatch(stripAnsi(bar), /\d+%/);
  });
});

describe('review-card tones stay truthful', () => {
  it('reserves success tone for verified complete only', () => {
    assert.equal(reviewTitleTone('VERIFIED_COMPLETE'), 'success');
    assert.equal(reviewTitleTone('COMPLETE_UNVERIFIED'), 'warning');
    assert.equal(reviewTitleTone('VERIFICATION_FAILED'), 'error');
    assert.equal(reviewTitleTone('BLOCKED'), 'warning');
    assert.equal(reviewTitleTone('CANCELLED'), 'muted');
    assert.equal(reviewTitleTone('BUDGET_EXHAUSTED'), 'warning');
    assert.equal(reviewTitleTone('INFRA_FAILURE'), 'error');
    assert.equal(reviewTitleTone('AGENT_FAILURE'), 'error');
  });

  it('paints not-applicable complete as neutral success, distinct from verified', () => {
    assert.equal(reviewTitleTone('COMPLETE_UNVERIFIED', true), 'success');
    assert.equal(reviewTitleTone('VERIFIED_COMPLETE', true), 'success');
    const card = presentChatReview({
      outcome: 'NO_CHANGE_REQUIRED',
      changedFiles: [],
      verificationPolicy: 'not_applicable',
      summary: 'Read-only answer.',
    });
    assert.equal(card.looksLikeVerifiedSuccess, false);
    assert.equal(looksLikeVerifiedSuccess(card.kind), false);
    const plain = stripAnsi(card.body);
    assert.match(plain, /Complete/);
    assert.doesNotMatch(plain, /Verified complete/);
    const child = runColored(`
      import { presentChatReview } from './src/ui/reviewCard.ts';
      import { muted, success } from './src/ui/theme.ts';
      const card = presentChatReview({
        outcome: 'NO_CHANGE_REQUIRED',
        changedFiles: [],
        verificationPolicy: 'not_applicable',
      });
      if (!card.body.includes(success('✓ Complete'))) { console.error('missing success title'); process.exit(2); }
      if (muted('✓ Complete') === success('✓ Complete')) { console.error('color helpers collapsed'); process.exit(3); }
      if (card.body.includes(muted('✓ Complete'))) { console.error('used muted paint'); process.exit(4); }
      process.stdout.write('ok');
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  it('keeps unverified visually distinct from verified success', () => {
    const unverified = presentChatReview({
      outcome: 'UNVERIFIED_PATCH',
      changedFiles: ['src/foo.ts'],
      verification: { ran: false },
    });
    const verified = presentChatReview({
      outcome: 'VERIFIED_COMPLETE',
      changedFiles: ['src/foo.ts'],
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
    });
    assert.equal(unverified.looksLikeVerifiedSuccess, false);
    assert.equal(verified.looksLikeVerifiedSuccess, true);
    assert.match(stripAnsi(unverified.body), /unverified|Not run/i);
    assert.match(stripAnsi(verified.body), /Verified complete/);
    assert.ok(unverified.body.includes(warning('○ Complete — unverified')));
    assert.ok(verified.body.includes(success('✓ Verified complete')));
  });
});

describe('identity accent is not a status color on daily-driver paths', () => {
  it('paints plan-mode BLOCKED with warning(), not accent', () => {
    const panel = renderPlanModeWarning();
    assert.match(stripAnsi(panel), /BLOCKED/);
    const child = runColored(`
      import { renderPlanModeWarning } from './src/ui/renderers.ts';
      import { warning, accent } from './src/ui/theme.ts';
      const panel = renderPlanModeWarning();
      if (!panel.includes(warning('BLOCKED'))) { console.error('missing warning BLOCKED'); process.exit(2); }
      if (warning('BLOCKED') === accent('BLOCKED')) { console.error('color helpers collapsed'); process.exit(3); }
      if (panel.includes(accent('BLOCKED'))) { console.error('used accent BLOCKED'); process.exit(4); }
      process.stdout.write('ok');
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  it('paints error-panel kind with error(), not accent', () => {
    const panel = renderErrorPanel('TOOL_TIMEOUT', 'the shell did not return');
    assert.ok(panel.includes(error('TOOL_TIMEOUT')));
    assert.match(stripAnsi(panel), /the shell did not return/);
  });

  it('paints tool-renderer paths with primary(), not accent()', () => {
    const renderer = new ReadFileRenderer();
    const line = renderer.renderComplete({
      toolId: '1',
      toolName: 'Read',
      toolInput: { path: 'src/ui/statusBar.ts' },
      status: 'complete',
    });
    assert.match(stripAnsi(line), /src\/ui\/statusBar\.ts/);
    assert.ok(stripAnsi(line).includes('Read'));
    const child = runColored(`
      import { ReadFileRenderer } from './src/ui/toolRenderers.ts';
      import { accent, primary } from './src/ui/theme.ts';
      const line = new ReadFileRenderer().renderComplete({
        toolId: '1', toolName: 'Read',
        toolInput: { path: 'src/ui/statusBar.ts' }, status: 'complete',
      });
      if (!line.includes(primary('src/ui/statusBar.ts'))) { console.error('missing primary path'); process.exit(2); }
      if (primary('src/ui/statusBar.ts') === accent('src/ui/statusBar.ts')) { console.error('color helpers collapsed'); process.exit(3); }
      if (line.includes(accent('src/ui/statusBar.ts'))) { console.error('used accent path'); process.exit(4); }
      process.stdout.write('ok');
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});

describe('tool presentation still distinguishes success / failure / unverified without color', () => {
  it('uses glyphs plus words so NO_COLOR remains readable', () => {
    const successLine = stripAnsi(
      renderToolExecutionTrail(
        [{ tool: 'write_file', target: 'a.ts', exitCode: 0, status: 'success' }],
        false,
        80,
      ),
    );
    const failLine = stripAnsi(
      renderToolExecutionTrail(
        [{ tool: 'run_command', target: 'npm test', exitCode: 1, status: 'failure' }],
        false,
        80,
      ),
    );
    const unknownLine = stripAnsi(
      renderToolExecutionTrail(
        [{ tool: 'run_command', target: 'npm test', status: 'unknown' }],
        false,
        80,
      ),
    );
    assert.match(successLine, /✔/);
    assert.match(failLine, /✖/);
    assert.match(failLine, /failed/i);
    assert.match(unknownLine, /○/);
    assert.match(unknownLine, /unverified/i);
    assert.notEqual(successLine, failLine);
    assert.notEqual(failLine, unknownLine);
  });
});
