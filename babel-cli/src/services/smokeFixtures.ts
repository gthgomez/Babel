import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SmokePlanFixture {
  name: string;
  path: string;
}

function writeJsonFile(path: string, data: unknown): void {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, json, 'utf-8');
}

function findGuaranteedReadTarget(projectRoot: string): string {
  const candidateFiles = [
    'README.md',
    'package.json',
    'build.gradle.kts',
    'app/build.gradle.kts',
  ];

  for (const relative of candidateFiles) {
    const full = join(projectRoot, relative);
    if (existsSync(full)) {
      return `/project/${relative.replace(/\\/g, '/')}`;
    }
  }

  const entries = readdirSync(projectRoot, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  if (entries.length > 0) {
    return `/project/${entries[0]!.replace(/\\/g, '/')}`;
  }

  const readme = join(projectRoot, 'README.md');
  if (existsSync(readme)) return '/project/README.md';

  return '/project/package.json';
}

export function buildSmokeFixtures(runDir: string, projectRoot: string): SmokePlanFixture[] {
  const readOnlyPath = join(runDir, 'smoke_plan_read_only.json');
  const safeWritePath = join(runDir, 'smoke_plan_safe_write.json');
  const rejectionPath = join(runDir, 'smoke_plan_sandbox_rejection.json');
  const mcpUnknownServerPath = join(runDir, 'smoke_plan_mcp_unknown_server.json');
  const readTarget = findGuaranteedReadTarget(projectRoot);
  const safeWriteTarget = '/project/babel_smoke_tmp.txt';

  writeJsonFile(readOnlyPath, {
    plan_version: '1.0',
    thinking: 'Smoke test fixture designed to validate in-root read access and memory persistence.',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify manual-bridge executor can read a guaranteed in-root file and persist memory.',
    known_facts: [
      `Target project root is ${projectRoot}`,
      `Read target for this smoke run is ${readTarget}`,
      'Chronicle memory_store tool is available in executor contract',
    ],
    assumptions: [
      'Path jail allows read-only access inside the target project root',
    ],
    risks: [
      {
        risk: 'Chosen read target could be unavailable at runtime',
        likelihood: 'low',
        mitigation: 'Use deterministic pre-discovered file path from local filesystem scan',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read deterministic smoke target file',
        tool: 'file_read',
        target: readTarget,
        rationale: 'Validate in-root file_read resolution including /project virtual mount mapping',
        reversible: true,
        verification: 'Exit code is 0 and stdout is non-empty',
      },
      {
        step: 2,
        description: 'Persist smoke fact',
        tool: 'memory_store',
        target: 'smoke-read-only',
        rationale: 'Validate Chronicle write path under executor for the selected project root',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms storage',
      },
    ],
    root_cause: 'Previous smoke failures showed /project path mapping and project-root derivation drift; this case verifies the corrected in-root read path.',
    out_of_scope: [
      'Mutating application source code',
    ],
  });

  writeJsonFile(safeWritePath, {
    plan_version: '1.0',
    thinking: 'Smoke test fixture designed to validate write/read round-trips inside the project mount.',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Verify manual-bridge executor can write and re-read a temp file inside the target project root.',
    known_facts: [
      `Target project root is ${projectRoot}`,
      `Write target for this smoke run is ${safeWriteTarget}`,
      'Executor contract includes file_write and file_read',
    ],
    assumptions: [
      'Writing temp file under project root is permitted',
    ],
    risks: [
      {
        risk: 'Unexpected file permissions',
        likelihood: 'low',
        mitigation: 'Use temp filename and reversible write',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Write temp smoke file inside /project mount',
        tool: 'file_write',
        target: safeWriteTarget,
        rationale: 'Validate /project to project-root mapping for file_write on Windows',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms file write',
      },
      {
        step: 2,
        description: 'Read back the temp smoke file',
        tool: 'file_read',
        target: safeWriteTarget,
        rationale: 'Confirm write landed in project root and is readable',
        reversible: true,
        verification: 'Exit code is 0 and stdout contains the written text',
      },
      {
        step: 3,
        description: 'Store write smoke result in Chronicle',
        tool: 'memory_store',
        target: 'smoke-safe-write',
        rationale: 'Track write smoke completion',
        reversible: true,
        verification: 'Exit code is 0 and stdout confirms storage',
      },
    ],
    root_cause: 'Previous smoke failures halted on /project path mapping; this case validates corrected in-root write semantics.',
    out_of_scope: [
      'Editing existing application source files',
    ],
  });

  writeJsonFile(rejectionPath, {
    plan_version: '1.0',
    thinking: 'Negative smoke case for an explicitly disallowed shell command.',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Confirm safety controls reject a disallowed shell_exec command in manual bridge flow.',
    known_facts: [
      'SafeExecutor enforces an explicit command allowlist',
      'shell_exec should reject commands not present in the allowlist',
    ],
    assumptions: [
      'Either QA rejects this plan as unsafe or executor halts when shell_exec is denied',
    ],
    risks: [
      {
        risk: 'Model emits different command',
        likelihood: 'medium',
        mitigation: 'Use explicit target and verification text',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Invoke shell echo to trigger sandbox command rejection',
        tool: 'shell_exec',
        target: 'echo smoke-sandbox-rejection',
        rationale: 'Intentional negative test for sandbox rejection',
        reversible: true,
        verification: 'Either QA rejects for safety OR executor halts with sandbox rejection and structured denial metadata',
      },
    ],
    root_cause: 'The failure mode under test is unsafe command execution; robust behavior is explicit rejection before mutation.',
    out_of_scope: [
      'Any successful code modification',
    ],
  });

  writeJsonFile(mcpUnknownServerPath, {
    plan_version: '1.0',
    thinking: 'Negative smoke case for an unknown MCP server request.',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Confirm manual bridge surfaces structured MCP lifecycle metadata for an unknown MCP server request.',
    known_facts: [
      'mcp_request is a read-only executor tool',
      'Babel validates the MCP server name before spawning a child process',
    ],
    assumptions: [
      'Executor should halt with STEP_VERIFICATION_FAIL when mcp_request targets an unconfigured server',
    ],
    risks: [
      {
        risk: 'Model emits a different server name',
        likelihood: 'medium',
        mitigation: 'Use explicit target and verification text',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Call an unconfigured MCP server to trigger lifecycle evidence',
        tool: 'mcp_request',
        target: 'missing-server → smoke lifecycle probe',
        rationale: 'Intentional negative test for MCP lifecycle visibility on governed read-only requests',
        reversible: true,
        verification: 'Executor halts with unknown-server lifecycle metadata captured in the execution report',
      },
    ],
    root_cause: 'The failure mode under test is MCP control-plane misconfiguration; robust behavior is explicit lifecycle evidence at the validation boundary.',
    out_of_scope: [
      'Any successful MCP request execution',
    ],
  });

  return [
    { name: 'read_only', path: readOnlyPath },
    { name: 'safe_write', path: safeWritePath },
    { name: 'sandbox_rejection', path: rejectionPath },
    { name: 'mcp_unknown_server', path: mcpUnknownServerPath },
  ];
}
