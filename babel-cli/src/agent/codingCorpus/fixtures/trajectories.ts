/**
 * Offline fixture trajectories: planted observation-blindness vs hardened replay.
 */

import type { CorpusTrajectory } from '../types.js'

const longHead = `${'ok\n'.repeat(80)}PLANTED_TAIL_FAILURE expected 3 received 2`

export const PLANTED_BLINDNESS_TRAJECTORIES: CorpusTrajectory[] = [
  {
    task_id: 'sf-01',
    harness: 'fixture',
    events: [
      {
        turn: 1,
        kind: 'observation',
        command: 'npm test',
        exitCode: 1,
        stdout: 'npm banner only',
        stderr: 'Error: planted-stderr-only-failure',
        observation: '### run_command\nexit_code: 1\n```\nnpm banner only\n```',
      },
      { turn: 2, kind: 'finish', claimedComplete: true, hiddenTestsPassed: false },
    ],
  },
  {
    task_id: 'sf-02',
    harness: 'fixture',
    events: [
      {
        turn: 1,
        kind: 'observation',
        command: 'pytest',
        exitCode: 1,
        stdout: longHead,
        stderr: '',
        observation: '### run_command\nexit_code: 1\n```\nok\nok\nok\n```',
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
  {
    task_id: 'sf-03',
    harness: 'fixture',
    events: [
      {
        turn: 1,
        kind: 'read_range',
        path: 'max.go',
        startLine: 200,
        endLine: 250,
        skipped: true,
        skipReason: 'path_hash',
        observation: 'Skipping re-injection',
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
  {
    task_id: 'sf-04',
    harness: 'fixture',
    events: [
      {
        turn: 1,
        kind: 'observation',
        command: 'cargo test',
        exitCode: 1,
        stdout: `${'x'.repeat(3000)}PLANTED_OVERFLOW`,
        stderr: 'e',
        observation: '### cargo\nexit 1\nxxx...',
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
]

export const HARDENED_REPLAY_TRAJECTORIES: CorpusTrajectory[] = [
  {
    task_id: 'sf-01',
    harness: 'babel_hardened',
    events: [
      { turn: 1, kind: 'mutation', path: 'src/add.ts' },
      {
        turn: 2,
        kind: 'verifier',
        command: 'npm test -- add',
        exitCode: 1,
        stdout: 'FAIL add.test.ts',
        stderr: 'Error: planted-stderr-only-failure',
        observation:
          '### test_run npm test -- add\nexit_code: 1\nstderr_head:\nError: planted-stderr-only-failure',
        parsedFailures: ['planted-stderr-only-failure'],
      },
      { turn: 3, kind: 'read_range', path: 'src/add.ts', startLine: 1, endLine: 20, skipped: false },
      { turn: 3, kind: 'hypothesis', hypothesis: 'wrong operator' },
      { turn: 4, kind: 'mutation', path: 'src/add.ts' },
      {
        turn: 5,
        kind: 'verifier',
        command: 'npm test -- add',
        exitCode: 0,
        stdout: 'PASS',
        stderr: '',
        observation: '### test_run\nexit_code: 0\nsummary: ok',
      },
      { turn: 6, kind: 'finish', claimedComplete: true, hiddenTestsPassed: true },
    ],
  },
  {
    task_id: 'sf-02',
    harness: 'babel_hardened',
    events: [
      {
        turn: 1,
        kind: 'observation',
        command: 'pytest',
        exitCode: 1,
        stdout: longHead,
        stderr: '',
        observation: `### run_command pytest\nexit_code: 1\nstdout_tail:\n${longHead.slice(-80)}`,
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
  {
    task_id: 'sf-03',
    harness: 'babel_hardened',
    events: [
      {
        turn: 1,
        kind: 'read_range',
        path: 'max.go',
        startLine: 200,
        endLine: 250,
        skipped: false,
        observation: 'returned lines 200-250',
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
  {
    task_id: 'sf-04',
    harness: 'babel_hardened',
    events: [
      {
        turn: 1,
        kind: 'observation',
        command: 'cargo test',
        exitCode: 1,
        stdout: `${'x'.repeat(3000)}PLANTED_OVERFLOW`,
        stderr: 'e',
        rawSpillPath: '.babel/runs/demo/tool-output-1.log',
        observation:
          '### cargo\nexit_code: 1\nstdout_tail:\nPLANTED_OVERFLOW\nraw_output: .babel/runs/demo/tool-output-1.log\nstderr_head:\ne',
      },
      { turn: 2, kind: 'finish', claimedComplete: false, hiddenTestsPassed: false },
    ],
  },
]
