import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSyntheticProviderFixtureReady,
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  test('Deep planning and review retain their ordered, bounded workflow in an isolated provider fixture', async (t) => {
    const fixture = prepareSyntheticProviderFixture();
    t.after(() => removeSyntheticProviderFixture(fixture.root));
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url)
          .href,
        '--import',
        import.meta.resolve('tsx'),
        '--test',
        '--test-reporter=tap',
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: fixture.cwd,
        env: fixture.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const code = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(1));
      child.once('close', (value) => resolve(value ?? 1));
    });
    t.diagnostic(summarizeSyntheticProviderOutput(output, code));
    for (const line of output
      .split('\n')
      .filter((line) => /^not ok \d+ - |^# DEEP_PLANNING_FIXTURE /.test(line)))
      t.diagnostic(line);
    assert.equal(
      code,
      0,
      'Deep must retain review, original scope and bounded recovery',
    );
  });
} else {
  process.env['BABEL_LIVE'] = 'true';
  process.env['BABEL_DRY_RUN'] = 'false';
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  process.env['BABEL_DESKTOP_PROVIDER'] = 'openrouter';
  process.env['BABEL_DESKTOP_MODEL_ROUTE'] = 'glm-5.3-flash';
  const { EvidenceBundle } = await import('../evidence.js');
  const { exportEvidenceBundle } = await import('../services/evidenceProduct.js');
  const { OrchestratorManifestSchema, SwePlanSchema } =
    await import('../schemas/agentContracts.js');
  const { _runBabelPipelineInternal } = await import('../pipeline.js');
  const { withPipelineModelRoute } = await import('../execute.js');
  const { globalCostTracker } = await import('../services/costTracker.js');
  const task =
    'Inspect existing.txt and explain its contents. Do not modify any files or run mutating commands.';
  const plan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'EVIDENCE_REQUEST',
    task_summary: task,
    assumptions: [],
    risks: [],
    out_of_scope: [],
    root_cause: 'Read-only inspection',
    minimal_action_set: [
      {
        step: 1,
        tool: 'file_read',
        target: 'existing.txt',
        description: 'Read the owner-requested file',
        rationale: 'Inspect actual evidence',
        reversible: true,
        verification: 'Observe its contents',
      },
    ],
  });
  const manifest = () =>
    OrchestratorManifestSchema.parse({
      orchestrator_version: '9.0',
      target_project: 'global',
      target_project_path: process.cwd(),
      analysis: {
        task_summary: task,
        task_category: 'Backend',
        secondary_category: null,
        task_overlay_ids: [],
        complexity_estimate: 'Low',
        pipeline_mode: 'deep',
        purpose_mode: 'execution',
        purpose_source: 'fallback_default',
        purpose_confidence: 0.9,
        ambiguity_note: null,
        routing_confidence: 0.95,
      },
      platform_profile: {
        profile_source: 'not_required_for_routing',
        client_surface: 'unspecified',
        container_model: null,
        ingestion_mode: 'none',
        repo_write_mode: null,
        output_surface: [],
        platform_modes: [],
        execution_trust: null,
        data_trust: null,
        freshness_trust: null,
        action_trust: null,
        approval_mode: 'none',
      },
      worker_configuration: {
        assigned_model: 'deepseek-v4-pro',
        rationale:
          'Legacy schema family; effective route is pinned and asserted separately',
      },
      compilation_state: 'uncompiled',
      instruction_stack: {
        behavioral_ids: ['behavioral_core_v11'],
        domain_id: 'domain_swe_backend',
        skill_ids: [],
        model_adapter_id: 'adapter_codex',
        project_overlay_id: null,
        task_overlay_ids: [],
        pipeline_stage_ids: [],
      },
      resolution_policy: {
        apply_domain_default_skills: true,
        expand_skill_dependencies: true,
        strict_conflict_mode: 'error',
        task_shape_profile: 'full',
      },
      prompt_manifest: [],
      handoff_payload: {
        user_request: task,
        system_directive: 'Controlled Deep stage-order fixture',
      },
    });
  for (const kind of [
    'evidence',
    'handoff-privacy',
    'handoff-request-privacy',
    'handoff-junction-race',
    'handoff-metadata-race',
    'executor-directory-race',
    'executor-tool-directory-race',
    'discovery-secret-redaction',
    'discovery-guard-loss',
    'discovery-guard-baseline',
    'discovery-timing-failure',
    'cancel-during-discovery',
    'handoff-exact',
    'handoff-admission-change',
    'handoff-linked-artifact',
    'handoff-sensitive-metadata',
    'handoff-invalid-owner',
    'handoff-contractless',
    'handoff-chat-mode',
    'handoff-plan-mode',
    'handoff-unspecified-mode',
    'handoff-shell-escape',
    'handoff-executor-read-escape',
    'handoff-mutation-contained',
    'handoff-godot-readonly',
    'handoff-executor-write-contained',
    'handoff-command-contained',
    'handoff-no-implicit',
    'answer-unavailable',
    'answer-forbidden',
    'cancel-before-answer',
    'cancel-during-answer',
    'qa-reject',
    'wrong-plan-type',
    'evidence-godot',
    'premature-completion',
    'cancel-during-planning',
    'cancel-during-qa',
    'cancel-before-write',
    'cancel-during-orchestration',
    'cancel-during-finalization',
  ] as const)
    test(`Deep planning contract: ${kind}`, async (t) => {
      const rejected = kind === 'qa-reject';
      writeFileSync('existing.txt', 'preserved owner source');
      const handoffId = '20260610T180000Z-plan-abcdef01';
      let handoffRaceSwapped = false;
      let calls = 0;
      let directoryRaceAtCall = -1;
      let directoryRaceStack = '';
      const directoryLeakCalls: number[] = [];
      if (kind === 'handoff-admission-change') {
        if (process.platform !== 'win32') { t.skip('Windows directory helper'); return; }
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt'], required_reads: [] }));
        const modelPath = join(runDir, 'model_plan.json');
        writeFileSync(modelPath, JSON.stringify({ summary: 'original plan' }));
        const original = childProcess.spawn; let helperCount = 0;
        t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof childProcess.spawn>) => {
          const child = original(...args);
          if (++helperCount === 2) {
            const kill = child.kill.bind(child);
            child.kill = ((signal?: Parameters<typeof child.kill>[0]) => {
              if (!handoffRaceSwapped) { handoffRaceSwapped = true; writeFileSync(modelPath, JSON.stringify({ summary: 'changed plan' })); }
              return kill(signal);
            }) as typeof child.kill;
          }
          return child;
        }) as typeof childProcess.spawn);
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }); });
      }
      if (kind === 'discovery-guard-baseline') {
        const marker = join(process.cwd(), 'SYNTHETIC_GUARD_LOSS_NAME');
        writeFileSync(marker, 'synthetic');
        t.after(() => rmSync(marker, { force: true }));
      }
      if (kind === 'discovery-guard-loss') {
        if (process.platform !== 'win32') { t.skip('Windows directory helper'); return; }
        const marker = join(process.cwd(), 'SYNTHETIC_GUARD_LOSS_NAME');
        writeFileSync(marker, 'synthetic');
        let helper: ReturnType<typeof childProcess.spawn> | undefined;
        const originalSpawn = childProcess.spawn;
        const originalOpen = fs.opendirSync;
        t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof childProcess.spawn>) => {
          const child = originalSpawn(...args); helper = child; return child;
        }) as typeof childProcess.spawn);
        t.mock.method(fs, 'opendirSync', ((...args: Parameters<typeof fs.opendirSync>) => {
          const directory = originalOpen(...args);
          if (!handoffRaceSwapped && calls === 0) {
            const read = directory.readSync.bind(directory);
            directory.readSync = () => {
              if (!handoffRaceSwapped) {
                handoffRaceSwapped = true;
                assert.ok(helper?.pid, 'owned guard must be started before discovery');
                process.kill(helper.pid);
              }
              return read();
            };
          }
          return directory;
        }) as typeof fs.opendirSync);
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(marker, { force: true }); });
      }
      if (kind === 'discovery-secret-redaction') {
        const source = join(process.cwd(), 'discovery-secret-fixture.txt');
        writeFileSync(source, 'DEEPSEEK_API_KEY=SYNTHETIC_DISCOVERY_SECRET\nSYNTHETIC_SAFE_PREVIEW');
        t.after(() => rmSync(source, { force: true }));
      }
      if (kind === 'executor-directory-race' || kind === 'executor-tool-directory-race') {
        const sourceDir = join(process.cwd(), 'directory-race');
        const outside = join(process.env['BABEL_STATE_DIR']!, 'directory-race-outside');
        mkdirSync(sourceDir); mkdirSync(outside);
        writeFileSync(join(sourceDir, 'safe.txt'), 'safe');
        writeFileSync(join(outside, 'SYNTHETIC_DIRECTORY_PRIVATE_NAME'), 'private');
        const original = fs.opendirSync;
        const inject = (...args: unknown[]) => {
          if (!handoffRaceSwapped && (kind !== 'executor-tool-directory-race' || calls >= 3) && typeof args[0] === 'string' && (args[0].toLowerCase() === sourceDir.toLowerCase() || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) {
            handoffRaceSwapped = true; directoryRaceAtCall = calls; directoryRaceStack = new Error().stack ?? ''; const backup = join(process.cwd(), 'directory-race-before');
            fs.renameSync(sourceDir, backup);
            symlinkSync(outside, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
            try { return Reflect.apply(original, fs, args); }
            finally { fs.unlinkSync(sourceDir); fs.renameSync(backup, sourceDir); }
          }
          return Reflect.apply(original, fs, args);
        };
        t.mock.method(fs, 'opendirSync', inject as typeof fs.opendirSync);
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(sourceDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
      }
      if (kind === 'handoff-metadata-race') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        const planPath = join(runDir, 'model_plan.json');
        const replacement = join(process.env['BABEL_STATE_DIR']!, 'replacement-plan.json');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(planPath, JSON.stringify({ summary: 'safe Plan' }));
        writeFileSync(replacement, JSON.stringify({ summary: 'SYNTHETIC_METADATA_SWAP_CANARY' }));
        const original = fs.lstatSync;
        t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, ...args: unknown[]) => {
          const stat = original(path, ...(args as []));
          const observed = String(path)
          if (!handoffRaceSwapped && (observed.toLowerCase() === planPath.toLowerCase() || /(?:\/|\\)model_plan\.json$/i.test(observed))) {
            handoffRaceSwapped = true;
            fs.renameSync(planPath, join(runDir, 'model_plan-before.json'));
            fs.renameSync(replacement, planPath);
          }
          return stat;
        }) as typeof fs.lstatSync);
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(runDir, { recursive: true, force: true }); });
      }
      if (kind === 'handoff-junction-race') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        const sourceDir = join(process.cwd(), 'swapdir');
        const sourceFile = join(sourceDir, 'source.txt');
        const outside = join(process.env['BABEL_STATE_DIR']!, 'handoff-race-outside');
        mkdirSync(runDir, { recursive: true }); mkdirSync(sourceDir); mkdirSync(outside);
        writeFileSync(sourceFile, 'authorized synthetic source');
        writeFileSync(join(outside, 'source.txt'), 'SYNTHETIC_REQUEST_SWAP_CANARY');
        writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt', 'swapdir/source.txt'], required_reads: [] }));
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_RACE_PLAN' }));
        const planFile = join(runDir, 'model_plan.json');
        const originalOpen = fs.openSync;
        let planLoads = 0;
        t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
          if (String(path).toLowerCase() === planFile.toLowerCase() || /(?:\/|\\)model_plan\.json$/i.test(String(path))) planLoads++;
          return originalOpen(path, ...(args as [fs.OpenMode]));
        }) as typeof fs.openSync);
        const original = fs.lstatSync;
        t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, ...args: unknown[]) => {
          const stat = original(path, ...(args as []));
          // The pipeline first validates the handoff, then rebuilds it for the
          // request. Swap at the latter read so validation cannot consume the
          // fault and accidentally hide a request-boundary regression.
          const observed = String(path)
          if (planLoads >= 2 && !handoffRaceSwapped && (observed.toLowerCase() === sourceFile.toLowerCase() || /(?:\/|\\)source\.txt$/i.test(observed))) {
            handoffRaceSwapped = true;
            fs.renameSync(sourceDir, join(process.cwd(), 'swapdir-original'));
            symlinkSync(outside, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
          }
          return stat;
        }) as typeof fs.lstatSync);
        syncBuiltinESMExports();
        t.after(() => {
          t.mock.restoreAll(); syncBuiltinESMExports();
          rmSync(sourceDir, { recursive: true, force: true });
          rmSync(join(process.cwd(), 'swapdir-original'), { recursive: true, force: true });
          rmSync(runDir, { recursive: true, force: true });
        });
      }
      if (kind === 'handoff-exact') {
        const first = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        const newer = join(process.cwd(), 'runs', 'babel-lite', '20260610T180001Z-plan-abcdef02');
        mkdirSync(first, { recursive: true }); mkdirSync(newer, { recursive: true });
        writeFileSync(join(first, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt'], required_reads: [] }));
        writeFileSync(join(newer, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt'], required_reads: [] }));
        writeFileSync(join(first, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_PLAN_A', likely_files: ['existing.txt'] }));
        writeFileSync(join(newer, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_PLAN_B', likely_files: ['existing.txt'] }));
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }));
      }
      if (kind === 'handoff-privacy' || kind === 'handoff-request-privacy') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt', 'linked.txt', 'linked-dir/secret.txt', '.env.production.local', '.envrc'], required_reads: [] }));
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_SAFE_PLAN', likely_files: ['outside-scope.txt'] }));
        writeFileSync(join(runDir, 'plan.md'), 'SYNTHETIC_PRIVATE_PLAN_ARTIFACT');
        writeFileSync('outside-scope.txt', 'SYNTHETIC_OUTSIDE_SCOPE_PLAN');
        writeFileSync(join(process.env['BABEL_STATE_DIR']!, 'outside.txt'), 'SYNTHETIC_FORBIDDEN_OUTSIDE');
        linkSync(join(process.env['BABEL_STATE_DIR']!, 'outside.txt'), 'linked.txt');
        const outsideDir = join(process.env['BABEL_STATE_DIR']!, 'outside-dir');
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(outsideDir, 'secret.txt'), 'SYNTHETIC_FORBIDDEN_JUNCTION');
        symlinkSync(outsideDir, 'linked-dir', process.platform === 'win32' ? 'junction' : 'dir');
        writeFileSync('.env.production.local', 'SYNTHETIC_FORBIDDEN_ENV');
        writeFileSync('.envrc', 'SYNTHETIC_FORBIDDEN_ENVRC');
        writeFileSync('.env.SYNTHETIC_PROTECTED_NAME', 'fixture');
        t.after(() => { rmSync(outsideDir, { recursive: true, force: true }); rmSync('linked.txt', { force: true }); rmSync('linked-dir', { force: true }); rmSync('outside-scope.txt', { force: true }); rmSync('.env.production.local', { force: true }); rmSync('.envrc', { force: true }); rmSync('.env.SYNTHETIC_PROTECTED_NAME', { force: true }); rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }); });
      }
      if (kind === 'handoff-contractless') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId); mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Legacy Plan', likely_files: ['existing.txt'] }));
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }));
      }
      if (kind === 'handoff-chat-mode' || kind === 'handoff-plan-mode' || kind === 'handoff-unspecified-mode' || kind === 'handoff-shell-escape' || kind === 'handoff-executor-read-escape' || kind === 'handoff-mutation-contained' || kind === 'handoff-godot-readonly' || kind === 'handoff-executor-write-contained' || kind === 'handoff-command-contained') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId); mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['existing.txt'], required_reads: [] }));
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Selected Plan' }));
        if (kind === 'handoff-executor-read-escape') { writeFileSync('outside-executor.bin', 'SYNTHETIC_EXECUTOR_SCOPE_SECRET'); t.after(() => rmSync('outside-executor.bin', { force: true })); }
        if (kind === 'handoff-command-contained') { writeFileSync('synthetic-command.cjs', "require('node:fs').writeFileSync('synthetic-command-effect.txt', 'effect')"); t.after(() => { rmSync('synthetic-command.cjs', { force: true }); rmSync('synthetic-command-effect.txt', { force: true }); }); }
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }));
      }
      if (kind === 'handoff-linked-artifact') {
        const parent = join(process.cwd(), 'runs', 'babel-lite');
        const outside = join(process.env['BABEL_STATE_DIR']!, 'outside-plan');
        mkdirSync(parent, { recursive: true }); mkdirSync(outside);
        writeFileSync(join(outside, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_LINKED_ARTIFACT' }));
        symlinkSync(outside, join(parent, handoffId), process.platform === 'win32' ? 'junction' : 'dir');
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }));
      }
      if (kind === 'handoff-sensitive-metadata') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'OPENAI_API_KEY=SYNTHETIC_METADATA_SECRET', likely_files: ['existing.txt'] }));
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }));
      }
      if (kind === 'handoff-invalid-owner') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ project_root: 42 }))
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_INVALID_OWNER' }))
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }))
      }
      if (kind === 'handoff-no-implicit') {
        const runDir = join(process.cwd(), 'runs', 'babel-lite', handoffId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_UNSELECTED_PLAN', likely_files: ['existing.txt'] }))
        t.after(() => rmSync(join(process.cwd(), 'runs'), { recursive: true, force: true }))
      }
      globalCostTracker.resetSession();
      const controller = new AbortController();
      if (kind === 'cancel-during-discovery') {
        const original = fs.opendirSync; let aborted = false;
        t.mock.method(fs, 'opendirSync', ((...args: unknown[]) => {
          const entries = Reflect.apply(original, fs, args);
          if (!aborted && typeof args[0] === 'string' && (args[0].toLowerCase() === process.cwd().toLowerCase() || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) {
            aborted = true; controller.abort();
          }
          return entries;
        }) as typeof fs.opendirSync);
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      }
      const cancelAt = kind === 'cancel-during-orchestration' || kind === 'cancel-during-planning' ? 1 : kind === 'cancel-during-qa' ? 2 : kind === 'cancel-before-write' ? 3 : null;
      const cancelled = kind === 'cancel-before-answer' || kind === 'cancel-during-answer' || kind === 'cancel-during-finalization' || cancelAt !== null;
      const godot = kind === 'evidence-godot' || kind === 'premature-completion' || kind === 'handoff-godot-readonly';
      const ownerTask = kind === 'executor-directory-race' || kind === 'executor-tool-directory-race' ? 'List directory-race and report its entries. Do not modify files.' : kind === 'handoff-command-contained' ? 'Run node synthetic-command.cjs. Do not modify files.' : kind === 'handoff-no-implicit' ? 'Inspect existing.txt and explain how to apply its configuration. Do not modify files or run mutating commands.' : kind === 'cancel-before-write' || kind === 'handoff-mutation-contained' ? 'Refactor existing.txt to improve its implementation.' : godot ? `${task} Do not run any commands.` : task;
      const activePlan = kind === 'cancel-before-write' || kind === 'handoff-mutation-contained' ? { ...plan, plan_type: 'IMPLEMENTATION_PLAN', task_summary: ownerTask,
        minimal_action_set: [{...plan.minimal_action_set[0],tool:'file_write',target:'existing.txt',description:'Refactor the existing implementation'}] } : kind === 'executor-directory-race' || kind === 'executor-tool-directory-race' ? { ...plan, task_summary: ownerTask, minimal_action_set: [{ ...plan.minimal_action_set[0], tool: 'directory_list', target: 'directory-race', description: 'List the requested directory' }] } : plan;
      const shellPlan = { ...plan, minimal_action_set: [{ ...plan.minimal_action_set[0], tool: 'shell_exec', target: `node -e "require('fs').writeFileSync('outside-effect.txt','SYNTHETIC_EFFECT')"`, description: 'Attempt an out-of-scope effect' }] };
      let hostVerifications = 0;
      if (godot) {
        const wrapper = join(process.cwd(), 'synthetic-godot.ps1');
        writeFileSync(wrapper, '# Controlled wrapper marker; never executed.');
        writeFileSync('project.godot', '[application]\nconfig/name="Read-only fixture"\n');
        process.env['BABEL_GODOT_COMMAND'] = wrapper;
        process.env['BABEL_GODOT_POWERSHELL'] = 'synthetic-godot';
        const spawnSync = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof spawnSync>) => {
          if (args[0] === 'synthetic-godot') {
            hostVerifications++;
            return {pid:0,output:['','',''],stdout:'',stderr:'',status:0,signal:null};
          }
          return spawnSync(...args);
        });
        syncBuiltinESMExports();
        t.after(() => {
          t.mock.restoreAll();syncBuiltinESMExports();
          delete process.env['BABEL_GODOT_COMMAND'];delete process.env['BABEL_GODOT_POWERSHELL'];
          rmSync('project.godot', {force:true});rmSync(wrapper, {force:true});
        });
      }
      const reject = {
        verdict: 'REJECT',
        failure_count: 1,
        overall_confidence: 5,
        failures: [
          {
            tag: 'EVIDENCE-GATE',
            condition:
              'Controlled reviewer requires another inspection before execution.',
            confidence: 5,
          },
        ],
        proposed_fix_strategy: 'Inspect the requested evidence.',
      };
      const pass = { verdict: 'PASS', overall_confidence: 5 };
      const turns =
        kind === 'handoff-shell-escape'
          ? [shellPlan, shellPlan, shellPlan]
          : kind === 'wrong-plan-type'
          ? [{ ...plan, plan_type: 'IMPLEMENTATION_PLAN' }, pass]
          : kind === 'premature-completion'
            ? [plan, pass, {type:'completion',status:'EXECUTION_COMPLETE'}]
          : rejected
            ? [plan, reject, plan, reject, plan, reject]
            : [
                activePlan,
                pass,
                {
                  type: 'tool_call',
                  thinking: 'Read the authorized file',
                  tool: kind === 'executor-directory-race' || kind === 'executor-tool-directory-race' ? 'directory_list' : kind === 'cancel-before-write' || kind === 'handoff-executor-write-contained' ? 'file_write' : 'file_read',
                  path: kind === 'executor-directory-race' || kind === 'executor-tool-directory-race' ? 'directory-race' : kind === 'handoff-executor-read-escape' ? 'outside-executor.bin' : 'existing.txt',
                  ...(kind === 'cancel-before-write' ? {content:'Must not be written after cancellation'} : kind === 'handoff-executor-write-contained' ? {content:'Must not be written'} : {}),
                },
                {
                  answer:
                    'existing.txt contains "preserved owner source". No source files were modified.',
                },
              ];
      let sawSafePlan = false;
      let leakedExecutorScope = false;
      let leakedHandoffRace = false;
      t.mock.method(
        globalThis,
        'fetch',
        async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          assert.equal(
            String(url),
            'https://openrouter.ai/api/v1/chat/completions',
          );
          const body = JSON.parse(String(init?.body));
          if (kind === 'discovery-guard-loss' || kind === 'discovery-guard-baseline') leakedExecutorScope ||= String(init?.body).includes('SYNTHETIC_GUARD_LOSS_NAME');
          if (kind === 'discovery-secret-redaction') {
            leakedExecutorScope ||= String(init?.body).includes('SYNTHETIC_DISCOVERY_SECRET');
            sawSafePlan ||= String(init?.body).includes('SYNTHETIC_SAFE_PREVIEW');
          }
          if ((kind === 'executor-directory-race' || kind === 'executor-tool-directory-race') && String(init?.body).includes('SYNTHETIC_DIRECTORY_PRIVATE_NAME')) { leakedExecutorScope = true; directoryLeakCalls.push(calls + 1); }
          if (kind === 'handoff-executor-read-escape') leakedExecutorScope ||= String(init?.body).includes('SYNTHETIC_EXECUTOR_SCOPE_SECRET');
          if (kind === 'handoff-no-implicit') assert.equal(String(init?.body).includes('SYNTHETIC_UNSELECTED_PLAN'), false, 'unselected plan entered provider request');
          if (kind === 'handoff-sensitive-metadata') {
            assert.equal(String(init?.body).includes('SYNTHETIC_METADATA_SECRET'), false, 'artifact secret in provider request');
          }
          if (kind === 'handoff-junction-race') {
            leakedHandoffRace ||= String(init?.body).includes('SYNTHETIC_REQUEST_SWAP_CANARY');
            sawSafePlan ||= String(init?.body).includes('SYNTHETIC_RACE_PLAN');
          }
          if (kind === 'handoff-privacy' || kind === 'handoff-request-privacy') {
            const payload = String(init?.body);
            assert.equal(payload.includes('SYNTHETIC_FORBIDDEN_OUTSIDE'), false, 'outside marker in request');
            assert.equal(payload.includes('SYNTHETIC_FORBIDDEN_ENV'), false, 'dotenv marker in request');
            assert.equal(payload.includes('SYNTHETIC_FORBIDDEN_ENVRC'), false, 'direnv marker in request');
            assert.equal(payload.includes('SYNTHETIC_OUTSIDE_SCOPE_PLAN'), false, 'model-only path entered request');
            assert.equal(payload.includes('SYNTHETIC_FORBIDDEN_JUNCTION'), false, 'junction marker in request');
            assert.equal(payload.includes('SYNTHETIC_PROTECTED_NAME'), false, 'protected filename in request');
            assert.equal(payload.includes('SYNTHETIC_PRIVATE_PLAN_ARTIFACT'), false, 'private Plan artifact body in request');
            assert.equal(payload.includes('plan_run_dir:'), false, 'private Plan artifact location in request');
            sawSafePlan ||= payload.includes('SYNTHETIC_SAFE_PLAN');
          }
          if (kind === 'handoff-exact') {
            const payload = String(init?.body);
            assert.equal(payload.includes('SYNTHETIC_PLAN_B'), false, 'newer plan must not replace selected source');
            sawSafePlan ||= payload.includes('SYNTHETIC_PLAN_A');
          }
          assert.equal(body.model, 'z-ai/glm-5.3-flash');
          const turn = turns[calls++];
          if (calls === cancelAt) controller.abort();
          if (controller.signal.aborted && (kind === 'cancel-during-orchestration' || kind === 'cancel-during-qa')) throw controller.signal.reason;
          if (!rejected && kind !== 'wrong-plan-type' && kind !== 'executor-directory-race' && kind !== 'executor-tool-directory-race' && calls >= 4) {
            assert.match(String(init?.body), /preserved owner source/);
            assert.match(String(init?.body), /ORIGINAL OWNER REQUEST/);
            assert.match(String(init?.body), /untrusted evidence/);
            if (kind === 'cancel-during-answer') {
              controller.abort();
              assert.equal(init?.signal?.aborted, true, 'answer request must receive cancellation');
              throw controller.signal.reason;
            }
            if (kind === 'answer-unavailable' || kind === 'answer-forbidden')
              return new Response(
                JSON.stringify({
                  error: {
                    message: 'Controlled unavailable answer',
                    code: 401,
                  },
                }),
                { status: kind === 'answer-forbidden' ? 403 : 401 },
              );
          }
          assert.notEqual(
            turn,
            undefined,
            'no hidden model stages or unbounded retry',
          );
          return new Response(
            'data: ' +
              JSON.stringify({
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: JSON.stringify(turn) },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 10,
                  total_tokens: 20,
                  ...(kind === 'cancel-during-qa' && calls === 1 ? {cost:0.125} : {}),
                },
              }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      );
      const evidence = new EvidenceBundle(ownerTask, process.env['BABEL_RUNS_DIR']!);
      if (kind === 'discovery-timing-failure') {
        const write = evidence.writeDebugFile.bind(evidence);
        t.mock.method(evidence, 'writeDebugFile', (name: string, content: string) => {
          if (name === 'planning_discovery_timing_v1.json') throw new Error('synthetic timing storage failure');
          write(name, content);
        });
      }
      if (kind === 'cancel-before-answer') {
        const writeContext = evidence.writeCompiledContext.bind(evidence);
        t.mock.method(evidence, 'writeCompiledContext', (stage: string, context: string) => {
          writeContext(stage, context);
          if (stage === 'evidence_answer') controller.abort();
        });
      }
      if (kind === 'cancel-during-finalization') {
        const writeTrace = evidence.writeTraceContext.bind(evidence);
        t.mock.method(evidence, 'writeTraceContext', (...args: Parameters<typeof writeTrace>) => {
          writeTrace(...args);
          controller.abort();
        });
      }
      const activeManifest = manifest();
      activeManifest.analysis.task_summary = ownerTask;
      activeManifest.handoff_payload.user_request = ownerTask;
      const run = () => withPipelineModelRoute('glm-5.3-flash', () =>
        _runBabelPipelineInternal(
          ownerTask,
          {
            ...(kind === 'handoff-unspecified-mode' ? {} : { mode: kind === 'handoff-chat-mode' ? 'chat' as const : kind === 'handoff-plan-mode' ? 'plan' as const : 'deep' as const }),
            modelOverride: 'glm-5.3-flash',
            disableMemoryExtraction: true,
            writeLatestPointers: false,
            ...(kind === 'handoff-privacy' || kind === 'handoff-request-privacy' || kind === 'handoff-junction-race' || kind === 'handoff-metadata-race' || kind === 'handoff-exact' || kind === 'handoff-admission-change' || kind === 'handoff-linked-artifact' || kind === 'handoff-sensitive-metadata' || kind === 'handoff-invalid-owner' || kind === 'handoff-contractless' || kind === 'handoff-chat-mode' || kind === 'handoff-plan-mode' || kind === 'handoff-unspecified-mode' || kind === 'handoff-shell-escape' || kind === 'handoff-executor-read-escape' || kind === 'handoff-mutation-contained' || kind === 'handoff-godot-readonly' || kind === 'handoff-executor-write-contained' || kind === 'handoff-command-contained' ? { planRunId: handoffId } : {}),
            abortSignal: controller.signal,
          },
          evidence,
          kind === 'cancel-during-orchestration' || kind === 'handoff-linked-artifact' ? undefined : activeManifest,
        ),
      );
      if (kind === 'handoff-linked-artifact' || kind === 'handoff-sensitive-metadata' || kind === 'handoff-invalid-owner') {
        await assert.rejects(run, /saved plan source is unavailable/i);
        assert.equal(calls, 0, 'linked plan must fail before provider dispatch');
        return;
      }
      if (kind === 'cancel-during-discovery') {
        let outcome: Awaited<ReturnType<typeof run>> | undefined;
        try { outcome = await run(); } catch (error) { assert.equal((error as Error).name, 'AbortError'); }
        assert.equal(controller.signal.aborted, true, 'fixture must cancel during discovery');
        assert.equal(calls, 0, 'cancelled preparation must not dispatch a model request');
        const timing = JSON.parse(readFileSync(join(evidence.runDir, 'planning_discovery_timing_v1.json'), 'utf8'));
        assert.equal(timing.outcome, 'cancelled'); assert.ok(Number.isFinite(timing.duration_ms) && timing.duration_ms >= 0);
        if (outcome) {
          assert.equal(outcome.status, 'EXECUTOR_HALTED');
          const { buildRunResultPayload } = await import('../cli/structuredOutput.js');
          assert.equal(buildRunResultPayload(outcome, { task, mode: 'deep' })['terminal_outcome'], 'CANCELLED');
        }
        return;
      }
      if (kind === 'handoff-metadata-race') {
        await assert.rejects(run, /saved plan source is unavailable|Unsafe Plan source artifact/i);
        assert.equal(handoffRaceSwapped, true, 'fixture must swap the metadata at the actual read');
        assert.equal(calls, 0, 'replaced metadata must stop before provider dispatch');
        return;
      }
      if (kind === 'handoff-contractless') {
        await assert.rejects(run, /contract.*missing|contract.*unavailable/i); assert.equal(calls, 0); return;
      }
      if (kind === 'handoff-chat-mode' || kind === 'handoff-plan-mode' || kind === 'handoff-unspecified-mode') {
        await assert.rejects(run, /plan.*deep|deep.*plan/i); assert.equal(calls, 0); return;
      }
      if (kind === 'handoff-command-contained') { await assert.rejects(run, /Plan-bound command execution is unavailable/); assert.equal(calls, 0); assert.equal(existsSync('synthetic-command-effect.txt'), false); return; }
      if (kind === 'handoff-mutation-contained') {
        const outcome = await run();
        assert.notEqual(outcome.status, 'COMPLETE');
        assert.equal(readFileSync('existing.txt', 'utf8'), 'preserved owner source');
        assert.equal(existsSync('outside-effect.txt'), false);
        return;
      }
      if (kind === 'cancel-during-orchestration') {
        await assert.rejects(run, { name: 'AbortError' });
        assert.equal(calls, 1);
        assert.equal(existsSync(join(evidence.runDir, '01_manifest.json')), false);
        const summary = JSON.parse(readFileSync(join(evidence.runDir, 'terminal_status_summary.json'), 'utf8'));
        assert.equal(summary.status, 'EXECUTOR_HALTED');
        assert.equal(summary.terminal_outcome, 'CANCELLED');
        assert.match(summary.condition_summary, /CANCELLED/);
        assert.equal(existsSync(join(evidence.runDir, '12_pre_execution_failure_capsule.json')), false);
        return;
      }
      if (kind === 'handoff-admission-change') {
        const changed = await run();
        assert.equal(handoffRaceSwapped, true, 'fixture must change the Plan between its guarded loads');
        assert.equal(calls, 0, 'changed Plan identity must be rejected before inference');
        assert.notEqual(changed.status, 'COMPLETE');
        assert.match(JSON.stringify(changed), /saved plan source or project changed during admission/i);
        return;
      }
      const result = await run();
      if (kind === 'discovery-timing-failure') {
        assert.ok(calls > 0, 'the optional timing failure must not discard useful task work');
        assert.match(readFileSync(join(evidence.runDir, '04_execution_report.json'), 'utf8'), /Planning discovery timing could not be recorded/);
        assert.equal(existsSync(join(evidence.runDir, 'planning_discovery_timing_v1.json')), false);
        return;
      }
      if (kind === 'handoff-request-privacy') {
        assert.equal(sawSafePlan, true, 'safe Plan must reach a captured provider request');
        assert.ok(calls > 0, 'a provider request must be captured');
        return;
      }
      if (kind === 'discovery-guard-baseline') {
        assert.ok(calls > 0, 'a provider request must be captured');
        assert.equal(leakedExecutorScope, true, 'the control marker must be observable when discovery remains guarded');
        const timing = JSON.parse(readFileSync(join(evidence.runDir, 'planning_discovery_timing_v1.json'), 'utf8'));
        assert.equal(timing.phase, 'planning_discovery'); assert.equal(timing.outcome, 'available');
        assert.ok(Number.isFinite(timing.duration_ms) && timing.duration_ms >= 0);
        assert.doesNotMatch(JSON.stringify(timing), /SYNTHETIC_GUARD_LOSS_NAME/);
        return;
      }
      if (kind === 'discovery-guard-loss') {
        assert.equal(handoffRaceSwapped, true, 'fixture must terminate the owned discovery guard');
        assert.ok(calls > 0, 'a provider request must be captured');
        assert.equal(leakedExecutorScope, false, 'inventory from an unguarded scan reached a provider request');
        const timing = JSON.parse(readFileSync(join(evidence.runDir, 'planning_discovery_timing_v1.json'), 'utf8'));
        assert.equal(timing.outcome, 'unavailable'); assert.ok(Number.isFinite(timing.duration_ms) && timing.duration_ms >= 0);
        return;
      }
      if (kind === 'discovery-secret-redaction') {
        assert.equal(sawSafePlan, true, 'safe discovery preview must reach a captured request');
        assert.equal(leakedExecutorScope, false, 'credential-shaped discovery value reached a captured request');
        const outputDir = join(process.env['BABEL_STATE_DIR']!, 'discovery-secret-export');
        const exported = exportEvidenceBundle({ runDir: evidence.runDir, outputDir });
        assert.equal(exported.status, 'ok', exported.error ?? 'export failed');
        assert.ok(exported.files_copied.length > 0);
        for (const name of exported.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes('SYNTHETIC_DISCOVERY_SECRET'), false);
        return;
      }
      if (kind === 'executor-directory-race' || kind === 'executor-tool-directory-race') {
        assert.equal(handoffRaceSwapped, true, `fixture must reach actual directory enumeration; calls=${calls}; result=${JSON.stringify(result).slice(0, 1800)}`);
        assert.equal(directoryRaceAtCall, kind === 'executor-directory-race' ? 0 : 3, `fault must reach its intended boundary; ${directoryRaceStack}`);
        assert.ok(calls >= 3, 'captured requests must include executor tool selection');
        assert.equal(leakedExecutorScope, false, `outside directory name reached provider request; swap after ${directoryRaceAtCall} calls, leaked calls ${directoryLeakCalls.join(',')}; ${directoryRaceStack}`);
        const outputDir = join(process.env['BABEL_STATE_DIR']!, `${kind}-export`);
        const exported = exportEvidenceBundle({ runDir: evidence.runDir, outputDir });
        assert.equal(exported.status, 'ok', exported.error ?? 'export failed');
        assert.ok(exported.files_copied.length > 0);
        for (const name of exported.files_copied) assert.equal(readFileSync(join(outputDir, name), 'utf8').includes('SYNTHETIC_DIRECTORY_PRIVATE_NAME'), false);
        return;
      }
      if (kind === 'handoff-godot-readonly') { assert.equal(result.status, 'READ_ONLY_NO_MODIFICATION'); assert.equal(hostVerifications, 0); return; }
      if (kind === 'handoff-executor-write-contained') { assert.notEqual(result.status, 'COMPLETE'); assert.equal(readFileSync('existing.txt', 'utf8'), 'preserved owner source'); return; }
      if (kind === 'handoff-executor-read-escape') { assert.equal(leakedExecutorScope, false, 'out-of-contract executor read reached provider'); return; }
      if (kind === 'handoff-shell-escape') {
        assert.equal(existsSync('outside-effect.txt'), false); assert.equal(calls, 3); assert.notEqual(result.status, 'COMPLETE'); return;
      }
      if (kind === 'handoff-exact') {
        assert.equal(sawSafePlan, true, 'selected older plan must reach the request');
        const timing = JSON.parse(readFileSync(join(evidence.runDir, 'planning_discovery_timing_v1.json'), 'utf8'));
        assert.equal(timing.outcome, 'plan_scope_suppressed');
        const { loadEpisodeEventLogFromDir } = await import('../evidence/episodeStream.js');
        const events = loadEpisodeEventLogFromDir(evidence.runDir); assert.ok(events);
        const planning = events.events.find(event => event.type === 'PIPELINE_PHASE_COMPLETED' && event.payload['phase'] === 'swe_planning');
        assert.equal(typeof planning?.payload['duration_ms'], 'number');
        assert.ok((planning?.payload['duration_ms'] as number) >= 0);
        const compiler = events.events.find(event => event.type === 'PIPELINE_STAGE_COMPLETED' && event.payload['stage'] === 'instruction_compilation');
        assert.equal(typeof compiler?.payload['duration_ms'], 'number');
        assert.ok((compiler?.payload['duration_ms'] as number) >= 0);
      }
      if (kind === 'handoff-privacy') {
        assert.equal(sawSafePlan, true, 'valid handoff must reach the request');
        const outputDir = join(process.env['BABEL_STATE_DIR']!, 'privacy-export');
        const exported = exportEvidenceBundle({ runDir: evidence.runDir, outputDir });
        assert.equal(exported.status, 'ok', exported.error ?? 'export failed');
        assert.ok(exported.files_copied.length > 0, 'privacy export must contain evidence to inspect');
        for (const name of exported.files_copied) {
          const bytes = readFileSync(join(outputDir, name), 'utf8');
          assert.equal(bytes.includes('SYNTHETIC_FORBIDDEN_OUTSIDE'), false, 'outside marker in export');
          assert.equal(bytes.includes('SYNTHETIC_FORBIDDEN_ENV'), false, 'dotenv marker in export');
          assert.equal(bytes.includes('SYNTHETIC_OUTSIDE_SCOPE_PLAN'), false, 'model-only path content in export');
          assert.equal(bytes.includes('SYNTHETIC_FORBIDDEN_JUNCTION'), false, 'junction marker in export');
          assert.equal(bytes.includes('SYNTHETIC_PROTECTED_NAME'), false, 'protected filename in export');
          assert.equal(bytes.includes('plan_run_dir'), false, 'private Plan artifact location in export');
        }
      }
      if (kind === 'handoff-junction-race') {
        assert.equal(handoffRaceSwapped, true, 'fixture must swap at the actual handoff read');
        assert.equal(sawSafePlan, true, 'valid Plan metadata must reach a provider request');
        assert.equal(leakedHandoffRace, false, 'junction-swap bytes reached a captured provider request');
        const outputDir = join(process.env['BABEL_STATE_DIR']!, 'race-export');
        const exported = exportEvidenceBundle({ runDir: evidence.runDir, outputDir });
        assert.equal(exported.status, 'ok', exported.error ?? 'export failed');
        assert.ok(exported.files_copied.length > 0);
        for (const name of exported.files_copied) {
          assert.equal(readFileSync(join(outputDir, name), 'utf8').includes('SYNTHETIC_REQUEST_SWAP_CANARY'), false, 'junction-swap bytes reached the export');
        }
      }
      t.diagnostic(
        'DEEP_PLANNING_FIXTURE ' +
          JSON.stringify({ kind, status: result.status, calls }),
      );
      assert.equal(
        readFileSync('existing.txt', 'utf8'),
        'preserved owner source',
      );
      if (godot) {
        t.diagnostic(`DEEP_PLANNING_FIXTURE ${JSON.stringify({kind,modelCalls:calls,hostVerifications})}`);
        assert.equal(hostVerifications,0,'read-only completion must not execute runtime verification or artifact repair');
      }
      if (kind === 'answer-unavailable' || kind === 'answer-forbidden') assert.equal(calls, 4, 'authentication rejection must not trigger another inference');
      else assert.equal(calls, cancelAt ?? (kind === 'cancel-before-answer' ? 3 : turns.length));
      if (rejected) assert.equal(result.status, 'QA_REJECTED_MAX_LOOPS');
      else if (kind === 'wrong-plan-type')
        assert.equal(result.status, 'EXECUTOR_HALTED');
      else if (kind === 'premature-completion') {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        const report = JSON.parse(readFileSync(join(evidence.runDir,'04_execution_report.json'),'utf8'));
        assert.equal(report.pipeline_error.halt_tag,'STEP_VERIFICATION_FAIL');
        assert.match(report.pipeline_error.condition, /EVIDENCE_REQUEST/);
        assert.equal(existsSync(join(evidence.runDir,'10_runtime_verification.json')),false);
      }
      else if (cancelled) {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        const {buildRunResultPayload} = await import('../cli/structuredOutput.js');
        const payload = buildRunResultPayload(result, {task, mode:'deep'});
        assert.equal(payload['terminal_outcome'], 'CANCELLED');
        assert.doesNotMatch(result.finalAnswer ?? '', /preserved owner source/);
        if (kind === 'cancel-during-qa') {
          const {buildCostLedger,usageSummaryFromCostLedger}=await import('../services/costLedger.js');
          const legacySummary=usageSummaryFromCostLedger(buildCostLedger({runId:evidence.runId,task:ownerTask,lane:'governed',waterfallEntries:evidence.getWaterfallLogSnapshot()}));
          t.diagnostic('DEEP_PLANNING_FIXTURE '+JSON.stringify({kind,reported:result.usageSummary?.reportedCostUSD,
            unknown:result.usageSummary?.unknownChargeCount,complete:result.usageSummary?.costComplete,
            ownerUnknown:globalCostTracker.getTaskSummary(evidence.runId).unknownChargeCount,
            ownerReceipts:globalCostTracker.getTaskChargeObservations(evidence.runId).length,
            telemetry:evidence.getWaterfallLogSnapshot().length,legacyUnknown:legacySummary.unknownChargeCount,
            legacyComplete:legacySummary.costComplete}));
          assert.equal(legacySummary.unknownChargeCount,0,'completed telemetry alone omits the dispatched QA attempt');
          assert.equal(legacySummary.actualCostUSD,0.125,'the old projection incorrectly treats the planning subtotal as complete');
          assert.equal(globalCostTracker.getTaskSummary(evidence.runId).unknownChargeCount,1);
          assert.equal(result.usageSummary?.reportedCostUSD,0.125);
          assert.equal(result.usageSummary?.unknownChargeCount,1,'dispatched cancellation remains an unknown charge after an earlier reported charge');
          assert.equal(result.usageSummary?.costComplete,false);
          assert.equal(result.usageSummary?.actualCostUSD,null);
          const ledger=JSON.parse(readFileSync(join(evidence.runDir,'cost_ledger.json'),'utf8'));
          assert.equal(usageSummaryFromCostLedger(ledger).unknownChargeCount,1,'persisted evidence retains the unresolved request');
        }
      } else if (kind === 'answer-unavailable' || kind === 'answer-forbidden') {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        assert.match(
          result.errors?.join(' ') ?? '',
          /could not produce the requested answer/,
        );
        assert.match(result.errors?.join(' ') ?? '', kind === 'answer-forbidden' ? /openrouter.*403/i : /openrouter.*401/i);
        assert.doesNotMatch(
          result.finalAnswer ?? '',
          /Evidence gathered and finalized/,
        );
      } else {
        assert.equal(result.status, 'READ_ONLY_NO_MODIFICATION');
        assert.match(result.finalAnswer ?? '', /existing\.txt/);
        assert.match(result.finalAnswer ?? '', /preserved owner source/);
      }
    });
}
