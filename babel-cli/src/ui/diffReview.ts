/**
 * One-step diff review that snapshots and restores the composer draft.
 * Reuses git + pager primitives; does not invent a new diff engine.
 */

import { runGitCommand } from '../utils/gitExec.js';
import { PagerOverlay } from './pagerOverlay.js';
import { ScrollbackBuffer } from './scrollback.js';

export interface ReviewDiffState {
  files: string[];
  draft: string;
  cwd?: string;
}

export interface DiffReviewPorts {
  getDiff: () => Promise<string> | string;
  getComposerDraft: () => string;
  setComposerDraft: (text: string) => void;
  showPager?: (content: string) => Promise<void>;
}

let lastReview: ReviewDiffState = { files: [], draft: '' };

export function rememberReviewDiff(state: ReviewDiffState): void {
  lastReview = {
    files: [...state.files],
    draft: state.draft,
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
  };
}

export function getLastReviewDiff(): ReviewDiffState {
  return {
    files: [...lastReview.files],
    draft: lastReview.draft,
    ...(lastReview.cwd !== undefined ? { cwd: lastReview.cwd } : {}),
  };
}

export function resetReviewDiffForTests(): void {
  lastReview = { files: [], draft: '' };
}

export async function collectWorkspaceDiff(cwd: string): Promise<string> {
  const result = await runGitCommand(['diff', '--color=never'], cwd);
  const staged = await runGitCommand(['diff', '--cached', '--color=never'], cwd);
  const parts = [result.stdout.trim(), staged.stdout.trim()].filter(Boolean);
  return parts.join('\n\n') || '(no unstaged or staged changes)';
}

/**
 * Open the relevant diff, then restore composer text exactly.
 */
export async function openDiffReview(ports: DiffReviewPorts): Promise<{
  restoredDraft: string;
  diffText: string;
}> {
  const draftBefore = ports.getComposerDraft();
  const diffText = await ports.getDiff();
  if (ports.showPager) {
    await ports.showPager(diffText);
  } else {
    const buffer = new ScrollbackBuffer();
    for (const line of diffText.split('\n')) {
      buffer.push(line);
    }
    await PagerOverlay.show(buffer);
  }
  ports.setComposerDraft(draftBefore);
  return { restoredDraft: draftBefore, diffText };
}

export async function openLastReviewDiff(ports: {
  getComposerDraft: () => string;
  setComposerDraft: (text: string) => void;
  cwd?: string;
  showPager?: (content: string) => Promise<void>;
}): Promise<{ restoredDraft: string; diffText: string }> {
  const cwd = ports.cwd ?? lastReview.cwd ?? process.cwd();
  return openDiffReview({
    getDiff: () => collectWorkspaceDiff(cwd),
    getComposerDraft: ports.getComposerDraft,
    setComposerDraft: ports.setComposerDraft,
    ...(ports.showPager ? { showPager: ports.showPager } : {}),
  });
}
