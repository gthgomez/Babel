import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface IdeBridgeContract {
  schema_version: 1;
  contract_id: 'babel.ide_bridge.read_only';
  read_only: true;
  intended_consumers: ['vscode_extension', 'local_webview'];
  views: Array<'run_timeline' | 'plan_review' | 'diffs' | 'checkpoint_list' | 'evidence_browser'>;
  approval_actions: 'session_only';
  host_mode: 'enhanced_repl';
  approval_semantics: string;
  mutation_policy: {
    mutates_workspace: false;
    mutates_git: false;
    remote_side_effects: false;
  };
}

export interface IdeBridgeEvidenceFile {
  name: string;
  path: string;
  size_bytes: number;
}

export interface IdeBridgeSnapshot {
  schema_version: 1;
  contract: IdeBridgeContract;
  run_dir: string;
  run_timeline: Array<{ file: string; label: string; present: boolean }>;
  plan_review: {
    plan_path: string | null;
    qa_path: string | null;
  };
  diffs: {
    checkpoint_dir: string | null;
    restore_available: boolean;
  };
  checkpoint_list: IdeBridgeEvidenceFile[];
  evidence_browser: IdeBridgeEvidenceFile[];
}

const TIMELINE_FILES = [
  ['01_manifest.json', 'manifest'],
  ['02_swe_plan.json', 'plan'],
  ['03_qa_verdict.json', 'qa'],
  ['04_execution_report.json', 'execution'],
] as const;

export function buildIdeBridgeContract(): IdeBridgeContract {
  return {
    schema_version: 1,
    contract_id: 'babel.ide_bridge.read_only',
    read_only: true,
    intended_consumers: ['vscode_extension', 'local_webview'],
    views: ['run_timeline', 'plan_review', 'diffs', 'checkpoint_list', 'evidence_browser'],
    approval_actions: 'session_only',
    host_mode: 'enhanced_repl',
    approval_semantics:
      'Approve/deny is available only inside the interactive REPL via the stdin coordinator and checklist pause-resume flow. IDE bridge snapshots remain read-only.',
    mutation_policy: {
      mutates_workspace: false,
      mutates_git: false,
      remote_side_effects: false,
    },
  };
}

function listFiles(dir: string): IdeBridgeEvidenceFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(dir, entry.name);
      return {
        name: entry.name,
        path,
        size_bytes: statSync(path).size,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function findCheckpointDir(runDir: string): string | null {
  const candidates = [join(runDir, 'checkpoints'), join(runDir, '04_checkpoints')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function buildIdeBridgeSnapshot(runDir: string): IdeBridgeSnapshot {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new Error(`Run directory does not exist: ${runDir}`);
  }

  const checkpointDir = findCheckpointDir(runDir);
  const evidenceFiles = listFiles(runDir);
  const planPath = join(runDir, '02_swe_plan.json');
  const qaPath = join(runDir, '03_qa_verdict.json');

  return {
    schema_version: 1,
    contract: buildIdeBridgeContract(),
    run_dir: runDir,
    run_timeline: TIMELINE_FILES.map(([file, label]) => ({
      file,
      label,
      present: existsSync(join(runDir, file)),
    })),
    plan_review: {
      plan_path: existsSync(planPath) ? planPath : null,
      qa_path: existsSync(qaPath) ? qaPath : null,
    },
    diffs: {
      checkpoint_dir: checkpointDir,
      restore_available: checkpointDir !== null,
    },
    checkpoint_list: checkpointDir ? listFiles(checkpointDir) : [],
    evidence_browser: evidenceFiles,
  };
}

export function formatIdeBridgeSnapshotHuman(snapshot: IdeBridgeSnapshot): string {
  return [
    'Babel IDE Bridge Snapshot',
    `Run: ${snapshot.run_dir}`,
    `Views: ${snapshot.contract.views.join(', ')}`,
    `Evidence files: ${snapshot.evidence_browser.length}`,
    `Checkpoints: ${snapshot.checkpoint_list.length}`,
    `Plan: ${snapshot.plan_review.plan_path ? basename(snapshot.plan_review.plan_path) : '(missing)'}`,
    `QA: ${snapshot.plan_review.qa_path ? basename(snapshot.plan_review.qa_path) : '(missing)'}`,
    `Policy: read-only bridge; approval_actions=${snapshot.contract.approval_actions}; host_mode=${snapshot.contract.host_mode}; no workspace, git, or remote mutation.`,
  ].join('\n');
}

export function readIdeBridgeEvidenceText(filePath: string, maxBytes = 64_000): string {
  const content = readFileSync(filePath, 'utf-8');
  if (Buffer.byteLength(content, 'utf-8') <= maxBytes) {
    return content;
  }
  return `${Buffer.from(content, 'utf-8').subarray(0, maxBytes).toString('utf-8')}\n...[truncated at ${maxBytes} bytes]`;
}
