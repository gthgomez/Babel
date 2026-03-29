import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function writeStubFiles(root: string, babelRoot: string): {
  claudeCmd: string;
  codexCmd: string;
} {
  const fakeLlmPath = join(root, 'fake-llm-v8.mjs');
  const targetProjectPath = JSON.stringify(babelRoot);
  const promptManifest = JSON.stringify([
    join(babelRoot, '01_Behavioral_OS', 'OLS-v7-Core-Universal.md'),
    join(babelRoot, '01_Behavioral_OS', 'OLS-v7-Guard-Auto.md'),
    join(babelRoot, '02_Domain_Architects', 'Clean_SWE_Backend-v7.md'),
    join(babelRoot, '02_Skills', 'Lang', 'TS-Zod-v1.md'),
    join(babelRoot, '02_Skills', 'DB', 'Supabase-PG-v1.md'),
    join(babelRoot, '03_Model_Adapters', 'Codex_Balanced.md'),
  ]);

  const fakeLlmSource = `
import { readFileSync } from 'node:fs';

const promptManifest = ${promptManifest};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildOrchestratorManifest() {
  return {
    orchestrator_version: '8.0',
    target_project: 'global',
    target_project_path: ${targetProjectPath},
    analysis: {
      task_summary: 'Pipeline regression: legacy v8 verified fallback lane.',
      task_category: 'Backend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'verified',
      ambiguity_note: null,
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
      assigned_model: 'Codex',
      rationale: 'Regression fixture selects Codex for the legacy verified fallback lane.',
    },
    prompt_manifest: promptManifest,
    handoff_payload: {
      user_request: 'Pipeline regression for the v8 verified fallback lane.',
      system_directive: 'Load the files in prompt_manifest in order. You are now the Worker Agent. Enter PLAN state and output your strategy before writing any code.',
    },
  };
}

function buildSwePlan() {
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Validate the v8 verified fallback lane.',
    known_facts: [
      'The orchestrator emitted a legacy compiled prompt_manifest.',
      'The worker and QA stages must continue without typed-stack compilation.',
    ],
    assumptions: [
      'This regression fixture only needs to verify the legacy verified control path.',
    ],
    risks: [
      {
        risk: 'The runtime could accidentally require v9-only compilation data.',
        likelihood: 'low',
        mitigation: 'Assert the written manifest has no v9-only compiler fields.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Inspect the legacy manifest artifact for the resolved verified fallback stack.',
        tool: 'file_read',
        target: 'runs/latest/01_manifest.json',
        rationale: 'Confirms the v8 manifest remains sufficient for worker planning and QA review.',
        reversible: true,
        verification: 'The manifest contains a populated prompt_manifest and no compilation_state.',
      },
    ],
    root_cause: 'N/A — regression coverage task',
    out_of_scope: [
      'Executing CLI tools',
      'Modifying repository files',
    ],
  };
}

function buildQaPass() {
  return {
    verdict: 'PASS',
    overall_confidence: 5,
    notes: 'Regression fixture plan is sufficient for the v8 verified fallback worker/QA path.',
  };
}

async function main() {
  const runnerKind = process.argv[2];
  let prompt = '';

  if (runnerKind === 'codex') {
    const promptPath = process.argv[process.argv.length - 1];
    if (!promptPath) {
      throw new Error('codex stub expected a prompt file path');
    }
    prompt = readFileSync(promptPath, 'utf-8');
  } else {
    prompt = await readStdin();
  }

  let payload;
  if (prompt.includes('OLS-v8-Orchestrator.md') || prompt.includes('"orchestrator_version": "8.0"')) {
    payload = buildOrchestratorManifest();
  } else if (prompt.includes('Analyze the task below and produce the SWE Plan')) {
    payload = buildSwePlan();
  } else if (prompt.includes('Review the SWE Plan below and produce a QA verdict')) {
    payload = buildQaPass();
  } else {
    throw new Error('Unrecognized Babel stage prompt in fake LLM runner.');
  }

  process.stdout.write(JSON.stringify(payload));
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
`.trimStart();

  writeFileSync(fakeLlmPath, fakeLlmSource, 'utf-8');

  const claudeCmd = join(root, 'claude.cmd');
  const codexCmd = join(root, 'codex.cmd');

  writeFileSync(
    claudeCmd,
    `@echo off\r\nnode "${fakeLlmPath}" claude\r\n`,
    'utf-8',
  );
  writeFileSync(
    codexCmd,
    [
      '@echo off',
      'set "last="',
      ':next',
      'if "%~1"=="" goto run',
      'set "last=%~1"',
      'shift',
      'goto next',
      ':run',
      `node "${fakeLlmPath}" codex "%last%"`,
      '',
    ].join('\r\n'),
    'utf-8',
  );

  return { claudeCmd, codexCmd };
}

function withPatchedEnv(
  envPatch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envPatch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-pipeline-v8-test-'));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const babelRoot = resolve(scriptDir, '..', '..');
  const { claudeCmd, codexCmd } = writeStubFiles(tempDir, babelRoot);

  try {
    await withPatchedEnv(
      {
        BABEL_CLAUDE_CMD: claudeCmd,
        BABEL_CLAUDE_ARGS: '',
        BABEL_CODEX_CMD: codexCmd,
        BABEL_CODEX_ARGS: '',
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        const { runBabelPipeline } = await import('../src/pipeline.js');
        const result = await runBabelPipeline(
          'Regression: prove v8 verified fallback worker and QA path remains intact.',
          {
            orchestratorVersion: 'v8',
            mode: 'verified',
          },
        );

        assert(result.status === 'COMPLETE', `expected COMPLETE status, got ${result.status}`);
        assert(result.manifest.orchestrator_version === '8.0', 'expected v8 orchestrator manifest');
        assert(result.manifest.prompt_manifest.length === 6, `expected populated v8 prompt_manifest, got ${result.manifest.prompt_manifest.length}`);
        assert(result.manifest.instruction_stack === undefined, 'expected no instruction_stack on v8 manifest');
        assert(result.manifest.compilation_state === undefined, 'expected no compilation_state on v8 manifest');
        assert(result.manifest.compiled_artifacts === undefined, 'expected no compiled_artifacts on v8 manifest');

        const manifestPath = join(result.runDir, '01_manifest.json');
        const swePlanPath = join(result.runDir, '02_swe_plan_v1.json');
        const qaVerdictPath = join(result.runDir, '03_qa_verdict_v1.json');
        const runtimeTelemetryPath = join(result.runDir, '06_runtime_telemetry.json');

        assert(existsSync(manifestPath), 'expected 01_manifest.json to be written');
        assert(existsSync(swePlanPath), 'expected 02_swe_plan_v1.json to be written');
        assert(existsSync(qaVerdictPath), 'expected 03_qa_verdict_v1.json to be written');
        assert(!existsSync(runtimeTelemetryPath), 'expected v8 fallback lane to omit runtime telemetry file');

        const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
          orchestrator_version?: string;
          prompt_manifest?: string[];
          instruction_stack?: unknown;
          compilation_state?: unknown;
          compiled_artifacts?: unknown;
          runtime_telemetry?: unknown;
        };
        const writtenQaVerdict = JSON.parse(readFileSync(qaVerdictPath, 'utf-8')) as {
          verdict?: string;
        };

        assert(writtenManifest.orchestrator_version === '8.0', `expected written v8 manifest, got ${writtenManifest.orchestrator_version}`);
        assert(Array.isArray(writtenManifest.prompt_manifest) && writtenManifest.prompt_manifest.length === 6, 'expected written v8 prompt_manifest to remain populated');
        assert(writtenManifest.instruction_stack === undefined, 'expected written v8 manifest to omit instruction_stack');
        assert(writtenManifest.compilation_state === undefined, 'expected written v8 manifest to omit compilation_state');
        assert(writtenManifest.compiled_artifacts === undefined, 'expected written v8 manifest to omit compiled_artifacts');
        assert(writtenManifest.runtime_telemetry === undefined, 'expected written v8 manifest to omit runtime telemetry');
        assert(writtenQaVerdict.verdict === 'PASS', `expected QA PASS, got ${writtenQaVerdict.verdict}`);
      },
    );

    console.log('v8 pipeline fallback regression test passed');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
