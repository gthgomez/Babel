import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const branch = git('branch', '--show-current');
const status = git('status', '--porcelain');
const mergeHead = (() => {
  try {
    return git('rev-parse', '--verify', 'MERGE_HEAD');
  } catch {
    return '';
  }
})();
const rebaseState = ['rebase-merge', 'rebase-apply'].some((path) => {
  try {
    return existsSync(git('rev-parse', '--git-path', path));
  } catch {
    return false;
  }
});

const failures = [];
if (!branch || branch === 'main' || branch === 'master') {
  failures.push(`integration branch required, got ${branch || '<detached>'}`);
}
if (status) failures.push('working tree is dirty');
if (mergeHead) failures.push('merge is in progress');
if (rebaseState) failures.push('rebase is in progress');

if (failures.length > 0) {
  console.error(`[integration-clean] FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[integration-clean] PASS: ${branch} is clean and not on a protected base branch`);
