// Read only explicit private reviewer state, never a credential store or repository.
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summarizeBabelReviews } from '../babel-cli/src/services/babelReviewMetrics.js';
import { assertReviewStateOutsideGit } from '../babel-cli/src/services/babelReviewSnapshot.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--state-dir' || !args[1]) throw new Error('USAGE_STATE_DIR_REQUIRED');
const state = assertReviewStateOutsideGit(resolve(args[1]));
const artifacts: Record<string, unknown>[] = [];
function readArtifacts(directory: string, depth: number) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth > 0 && !['source', 'snapshots', 'runs'].includes(entry.name)) readArtifacts(path, depth - 1);
    else if (entry.isFile() && /^(mimo-v2\.5-|longcat-2\.0-|deepseek-v4-flash-|chat-canary-).+\.json$/.test(entry.name) && lstatSync(path).size < 32 * 1024 * 1024) {
      try { artifacts.push(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>); } catch { /* incomplete artifact remains on disk */ }
    }
  }
}
readArtifacts(state, 4);
console.log(JSON.stringify(summarizeBabelReviews(artifacts), null, 2));
