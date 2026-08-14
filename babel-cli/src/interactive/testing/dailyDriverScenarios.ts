/**
 * Frozen Daily-Driver Scenario Corpus (18 Scenarios)
 *
 * Defines canonical scenario definitions, inputs, task classifications,
 * certification layers, and expected semantic outcomes for regression testing and certification.
 */

import type { ChatTaskClass } from '../../config/chatTaskClass.js';
import type { TerminalOutcome } from '../../schemas/agentContracts.js';

export type CertificationLayer =
  | 'REAL_PTY'
  | 'PRODUCTION_INTEGRATION'
  | 'CLASSIFIER'
  | 'PURE_INVARIANT';

export interface DailyDriverScenario {
  id: string;
  name: string;
  category:
    | 'fact_query'
    | 'inspection'
    | 'architecture'
    | 'quick_fix'
    | 'multi_file'
    | 'tool_failure'
    | 'large_output'
    | 'model_switch'
    | 'compaction'
    | 'provider_recovery'
    | 'cancellation'
    | 'resize'
    | 'session_resume'
    | 'verification'
    | 'multi_turn';
  certificationLayer: CertificationLayer;
  input: string;
  expectedTaskClass: ChatTaskClass;
  expectedOperation: 'READ_ONLY' | 'MUTATING' | 'HYBRID';
  expectedOutcome: TerminalOutcome;
  expectedCardTitlePattern: RegExp;
  requiresVerifier: boolean;
  notes?: string;
}

export const FROZEN_DAILY_DRIVER_SCENARIOS: readonly DailyDriverScenario[] = [
  {
    id: 'D01-repo-fact-query',
    name: 'Trivial repo fact query',
    category: 'fact_query',
    certificationLayer: 'CLASSIFIER',
    input: 'how many files are in the src directory?',
    expectedTaskClass: 'quick_inspect',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete|Answer/i,
    requiresVerifier: false,
  },
  {
    id: 'D02-bounded-inspect',
    name: 'Bounded inspection query',
    category: 'inspection',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'inspect the exports of src/index.ts without modifying anything',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete|Answer/i,
    requiresVerifier: false,
  },
  {
    id: 'D03-deep-arch-investigation',
    name: 'Deep architecture investigation',
    category: 'architecture',
    certificationLayer: 'CLASSIFIER',
    input: 'explain the entire prompt assembly and routing architecture in depth',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete|Answer/i,
    requiresVerifier: false,
  },
  {
    id: 'D04-one-line-fix',
    name: 'One-line typo fix',
    category: 'quick_fix',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'fix the typo in src/utils.ts on line 12',
    expectedTaskClass: 'quick_fix',
    expectedOperation: 'MUTATING',
    expectedOutcome: 'UNVERIFIED_PATCH',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D05-multi-file-implementation',
    name: 'Multi-file SWE implementation with tests',
    category: 'multi_file',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'fix the multi-file regression and run npm test before completing',
    expectedTaskClass: 'general_swe',
    expectedOperation: 'MUTATING',
    expectedOutcome: 'VERIFIED_COMPLETE',
    expectedCardTitlePattern: /Verified complete/i,
    requiresVerifier: true,
  },
  {
    id: 'D06-recursive-shell-fallback',
    name: 'Recursive shell enumeration failure with fallback',
    category: 'tool_failure',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'find all .ts files using find command; fallback if shell fails',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D07-repeated-tool-failure',
    name: 'Repeated tool execution failure',
    category: 'tool_failure',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'run the failing command and handle errors gracefully',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete|Answer/i,
    requiresVerifier: false,
  },
  {
    id: 'D08-huge-tool-output',
    name: 'Huge tool output truncation without crash',
    category: 'large_output',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'show contents of huge build artifact',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D09-model-switch',
    name: 'Interactive model switch preserves state',
    category: 'model_switch',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: '/model claude-3-5-sonnet',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete|Model/i,
    requiresVerifier: false,
  },
  {
    id: 'D10-compacted-context-sim',
    name: 'Compacted context preserves essential task state',
    category: 'compaction',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'continue previous multi-step implementation after compaction',
    expectedTaskClass: 'investigate',
    expectedOperation: 'MUTATING',
    expectedOutcome: 'UNVERIFIED_PATCH',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D11-provider-timeout-recovery',
    name: 'Provider timeout and clean failure recovery',
    category: 'provider_recovery',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'run heavy computation with provider timeout',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'INFRA_FAILURE',
    expectedCardTitlePattern: /Infrastructure failure|Failed/i,
    requiresVerifier: false,
  },
  {
    id: 'D12-ctrl-c-mid-stream',
    name: 'Ctrl+C cancellation during assistant stream',
    category: 'cancellation',
    certificationLayer: 'REAL_PTY',
    input: 'stream long response',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'CANCELLED',
    expectedCardTitlePattern: /Cancelled/i,
    requiresVerifier: false,
  },
  {
    id: 'D13-ctrl-c-tool-exec',
    name: 'Ctrl+C cancellation during tool execution',
    category: 'cancellation',
    certificationLayer: 'REAL_PTY',
    input: 'run long running test command',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'CANCELLED',
    expectedCardTitlePattern: /Cancelled/i,
    requiresVerifier: false,
  },
  {
    id: 'D14-resize-during-stream',
    name: 'Terminal resize during active output stream',
    category: 'resize',
    certificationLayer: 'REAL_PTY',
    input: 'generate multiline explanation with resize events',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D15-resume-session',
    name: 'Resume prior session and continue dialog',
    category: 'session_resume',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'what were we working on previously?',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
  {
    id: 'D16-verification-failure',
    name: 'Failing tests produce unverified / verification failed outcome',
    category: 'verification',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'modify src/math.ts and run tests',
    expectedTaskClass: 'default',
    expectedOperation: 'MUTATING',
    expectedOutcome: 'UNVERIFIED_PATCH',
    expectedCardTitlePattern: /Verification failed|Unverified/i,
    requiresVerifier: true,
  },
  {
    id: 'D17-verification-unavailable',
    name: 'Verification unavailable degrades gracefully without false green',
    category: 'verification',
    certificationLayer: 'PRODUCTION_INTEGRATION',
    input: 'fix src/format.ts when no test script exists',
    expectedTaskClass: 'default',
    expectedOperation: 'MUTATING',
    expectedOutcome: 'UNVERIFIED_PATCH',
    expectedCardTitlePattern: /Complete — unverified/i,
    requiresVerifier: false,
  },
  {
    id: 'D18-long-multiturn-chat',
    name: 'Long multi-turn chat maintains prompt responsiveness and clean state',
    category: 'multi_turn',
    certificationLayer: 'REAL_PTY',
    input: 'step 10 of a long interactive session',
    expectedTaskClass: 'investigate',
    expectedOperation: 'READ_ONLY',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
    expectedCardTitlePattern: /Complete/i,
    requiresVerifier: false,
  },
] as const;
