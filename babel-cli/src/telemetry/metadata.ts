import { existsSync, readFileSync } from 'node:fs';

import { hashOrderedIds, hashText } from './hash.js';

interface SessionStartRecord {
  PolicyVersionApplied?: string | null;
  ActivePolicyIds?: string[];
  RecommendedStackIds?: string[];
}

export interface HarnessMetadata {
  ciProvider?: string;
  ciRunId?: string;
  ciRunUrl?: string;
  vcsRepository?: string;
  vcsRef?: string;
  vcsSha?: string;
  pullRequestNumber?: string;
  deployEnvironment?: string;
  deployId?: string;
  deployTrigger?: string;
  policyVersionApplied?: string;
  activePolicyIdsHash?: string;
  recommendedStackIdsHash?: string;
  hasSessionStartPath: boolean;
  hasLocalLearningRoot: boolean;
  sessionStartPathHash?: string;
  localLearningRootHash?: string;
}

function readSessionStartRecord(sessionStartPath?: string): SessionStartRecord | null {
  if (!sessionStartPath || !existsSync(sessionStartPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(sessionStartPath, 'utf-8')) as SessionStartRecord;
  } catch {
    return null;
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildGitHubRunUrl(): string | undefined {
  const server = nonBlank(process.env['GITHUB_SERVER_URL']) ?? 'https://github.com';
  const repo = nonBlank(process.env['GITHUB_REPOSITORY']);
  const runId = nonBlank(process.env['GITHUB_RUN_ID']);

  if (!repo || !runId) {
    return undefined;
  }

  return `${server}/${repo}/actions/runs/${runId}`;
}

export function collectHarnessMetadata(sessionStartPath?: string, localLearningRoot?: string): HarnessMetadata {
  const sessionStartRecord = readSessionStartRecord(sessionStartPath);
  const isGitHubActions = process.env['GITHUB_ACTIONS'] === 'true';

  const ciProvider =
    nonBlank(process.env['BABEL_CI_PROVIDER']) ??
    (isGitHubActions ? 'github_actions' : undefined) ??
    (process.env['CI'] ? 'generic_ci' : undefined);

  const metadata: HarnessMetadata = {
    hasSessionStartPath: Boolean(nonBlank(sessionStartPath)),
    hasLocalLearningRoot: Boolean(nonBlank(localLearningRoot)),
  };

  const ciRunId = nonBlank(process.env['BABEL_CI_RUN_ID']) ?? nonBlank(process.env['GITHUB_RUN_ID']);
  const ciRunUrl = nonBlank(process.env['BABEL_CI_RUN_URL']) ?? buildGitHubRunUrl();
  const vcsRepository = nonBlank(process.env['GITHUB_REPOSITORY']);
  const vcsRef = nonBlank(process.env['BABEL_GIT_BRANCH']) ?? nonBlank(process.env['GITHUB_REF']);
  const vcsSha = nonBlank(process.env['BABEL_GIT_SHA']) ?? nonBlank(process.env['GITHUB_SHA']);
  const pullRequestNumber = nonBlank(process.env['BABEL_PR_NUMBER']);
  const deployEnvironment = nonBlank(process.env['BABEL_DEPLOY_ENV']);
  const deployId = nonBlank(process.env['BABEL_DEPLOY_ID']);
  const deployTrigger = nonBlank(process.env['BABEL_DEPLOY_TRIGGER']) ?? nonBlank(process.env['GITHUB_EVENT_NAME']);
  const policyVersionApplied = nonBlank(sessionStartRecord?.PolicyVersionApplied ?? undefined);
  const activePolicyIdsHash = sessionStartRecord?.ActivePolicyIds ? hashOrderedIds(sessionStartRecord.ActivePolicyIds) : undefined;
  const recommendedStackIdsHash = sessionStartRecord?.RecommendedStackIds ? hashOrderedIds(sessionStartRecord.RecommendedStackIds) : undefined;
  const sessionStartPathHash = nonBlank(sessionStartPath) ? hashText(sessionStartPath!) : undefined;
  const localLearningRootHash = nonBlank(localLearningRoot) ? hashText(localLearningRoot!) : undefined;

  if (ciProvider) metadata.ciProvider = ciProvider;
  if (ciRunId) metadata.ciRunId = ciRunId;
  if (ciRunUrl) metadata.ciRunUrl = ciRunUrl;
  if (vcsRepository) metadata.vcsRepository = vcsRepository;
  if (vcsRef) metadata.vcsRef = vcsRef;
  if (vcsSha) metadata.vcsSha = vcsSha;
  if (pullRequestNumber) metadata.pullRequestNumber = pullRequestNumber;
  if (deployEnvironment) metadata.deployEnvironment = deployEnvironment;
  if (deployId) metadata.deployId = deployId;
  if (deployTrigger) metadata.deployTrigger = deployTrigger;
  if (policyVersionApplied) metadata.policyVersionApplied = policyVersionApplied;
  if (activePolicyIdsHash) metadata.activePolicyIdsHash = activePolicyIdsHash;
  if (recommendedStackIdsHash) metadata.recommendedStackIdsHash = recommendedStackIdsHash;
  if (sessionStartPathHash) metadata.sessionStartPathHash = sessionStartPathHash;
  if (localLearningRootHash) metadata.localLearningRootHash = localLearningRootHash;

  return metadata;
}
