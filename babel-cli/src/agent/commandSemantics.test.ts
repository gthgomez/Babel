import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommandSemantics,
  isGatedGitPush,
  isCredentialExposureCommand,
  unwrapCommandWrappers,
  splitCommandParts,
} from './commandSemantics.js';

// ─── Normalization ───────────────────────────────────────────────────────────

test('unwrapCommandWrappers: unwraps sudo / bash -c / powershell / cmd /c', () => {
  assert.equal(unwrapCommandWrappers('sudo git push --force origin main'), 'git push --force origin main');
  assert.equal(unwrapCommandWrappers('bash -c "cat .env"'), 'cat .env');
  assert.equal(unwrapCommandWrappers('sh -c \'rm -rf ./build\''), 'rm -rf ./build');
  assert.equal(unwrapCommandWrappers('powershell -Command "Remove-Item -Recurse .\\x"'), 'Remove-Item -Recurse .\\x');
  assert.equal(unwrapCommandWrappers('cmd /c del /s /q tmp'), 'del /s /q tmp');
});

test('splitCommandParts: strips absolute/relative executable paths and .exe', () => {
  assert.deepEqual(splitCommandParts('git push'), { base: 'git', rest: 'push' });
  assert.deepEqual(splitCommandParts('C:\\tools\\git.exe push --force'), { base: 'git', rest: 'push --force' });
  assert.deepEqual(splitCommandParts('/usr/bin/git rebase'), { base: 'git', rest: 'rebase' });
  assert.deepEqual(splitCommandParts('./scripts/deploy.sh'), { base: 'deploy.sh', rest: '' });
});

// ─── Classification ──────────────────────────────────────────────────────────

test('classifyCommandSemantics: local read/test/write stay local', () => {
  assert.equal(classifyCommandSemantics('npm test'), 'test_local');
  assert.equal(classifyCommandSemantics('npx jest --runInBand'), 'test_local');
  assert.equal(classifyCommandSemantics('pytest tests/unit'), 'test_local');
  assert.equal(classifyCommandSemantics('npm run build'), 'test_local');
  assert.equal(classifyCommandSemantics('git commit -m "fix"'), 'git_commit');
  assert.equal(classifyCommandSemantics('rm build/out.js'), 'delete_local');
  assert.equal(classifyCommandSemantics('node scripts/fix.mjs'), 'unrecognized');
});

test('classifyCommandSemantics: destructive deletes escalate', () => {
  assert.equal(classifyCommandSemantics('rm -rf node_modules'), 'delete_destructive');
  assert.equal(classifyCommandSemantics('rm -fr ./x'), 'delete_destructive');
  assert.equal(classifyCommandSemantics('Remove-Item -Recurse -Force .\\x'), 'delete_destructive');
  assert.equal(classifyCommandSemantics('del /s /q tmp'), 'delete_destructive');
});

test('classifyCommandSemantics: installs and network reads are detected', () => {
  assert.equal(classifyCommandSemantics('npm install lodash'), 'install_dependency');
  assert.equal(classifyCommandSemantics('pip install requests'), 'install_dependency');
  assert.equal(classifyCommandSemantics('curl -s https://example.com'), 'network_read');
});

test('classifyCommandSemantics: credential exposure is tool-agnostic', () => {
  assert.equal(classifyCommandSemantics('cat .env'), 'credential_access');
  assert.equal(classifyCommandSemantics('type C:\\proj\\.env.local'), 'credential_access');
  assert.equal(classifyCommandSemantics('cat ~/.ssh/id_rsa'), 'credential_access');
  assert.equal(classifyCommandSemantics('Get-Content .env'), 'credential_access');
  assert.equal(classifyCommandSemantics('echo $OPENAI_API_KEY'), 'credential_access');
  assert.equal(classifyCommandSemantics('git log --all --pickaxe=secret'), 'credential_access');
  assert.equal(classifyCommandSemantics('bash -c "cat .env"'), 'credential_access');
  // .env.example is not a live credential store.
  assert.equal(isCredentialExposureCommand('cat .env.example'), false);
});

test('classifyCommandSemantics: git push semantics', () => {
  assert.equal(classifyCommandSemantics('git push origin feature'), 'git_push');
  assert.equal(classifyCommandSemantics('git push --force origin main'), 'git_push');
  assert.equal(classifyCommandSemantics('git.exe push -f'), 'git_push');
});

test('isGatedGitPush: force / main / master / delete only', () => {
  assert.equal(isGatedGitPush('git push origin feature'), false);
  assert.equal(isGatedGitPush('git push'), false);
  assert.equal(isGatedGitPush('git push --force origin main'), true);
  assert.equal(isGatedGitPush('git push -f'), true);
  assert.equal(isGatedGitPush('git push origin main'), true);
  assert.equal(isGatedGitPush('git push origin master'), true);
  assert.equal(isGatedGitPush('git push --delete origin feature'), true);
  assert.equal(isGatedGitPush('git push --force-with-lease'), true);
});

test('classifyCommandSemantics: history rewrite is detected', () => {
  assert.equal(classifyCommandSemantics('git reset --hard HEAD~2'), 'git_history_rewrite');
  assert.equal(classifyCommandSemantics('git rebase origin/main'), 'git_history_rewrite');
  assert.equal(classifyCommandSemantics('git commit --amend'), 'git_history_rewrite');
  assert.equal(classifyCommandSemantics('git clean -fd'), 'git_history_rewrite');
  assert.equal(classifyCommandSemantics('git branch -D old'), 'git_history_rewrite');
});

test('classifyCommandSemantics: pr / publish / infra / financial / db', () => {
  assert.equal(classifyCommandSemantics('gh pr create --draft'), 'create_pr');
  assert.equal(classifyCommandSemantics('npm publish'), 'deploy');
  assert.equal(classifyCommandSemantics('gh release create v1.0'), 'deploy');
  assert.equal(classifyCommandSemantics('terraform destroy -auto-approve'), 'infrastructure_mutation');
  assert.equal(classifyCommandSemantics('kubectl delete pod x'), 'infrastructure_mutation');
  assert.equal(classifyCommandSemantics('aws iam create-user bob'), 'infrastructure_mutation');
  assert.equal(classifyCommandSemantics('aws billing get-usage'), 'financial_external_effect');
  assert.equal(classifyCommandSemantics('docker rm -f web'), 'delete_destructive');
  assert.equal(classifyCommandSemantics('drop table users'), 'infrastructure_mutation');
  assert.equal(classifyCommandSemantics('truncate database foo'), 'infrastructure_mutation');
  assert.equal(classifyCommandSemantics('delete from audit_log'), 'infrastructure_mutation');
  // `git commit --amend` gates before plain commit classification.
  assert.equal(classifyCommandSemantics('git commit --amend -m x'), 'git_history_rewrite');
});

test('classifyCommandSemantics: external messaging', () => {
  assert.equal(
    classifyCommandSemantics('curl -X POST -d "{}" https://hooks.slack.com/services/ABC'),
    'external_message',
  );
  assert.equal(
    classifyCommandSemantics('curl -s -X POST https://discord.com/api/webhooks/123'),
    'external_message',
  );
});

test('classifyCommandSemantics: chained commands classify by most severe segment', () => {
  assert.equal(classifyCommandSemantics('test -f x && cat .env'), 'credential_access');
  assert.equal(classifyCommandSemantics('npm test; git push --force'), 'git_push');
});

test('classifyCommandSemantics: wrappers around high-impact commands survive', () => {
  assert.equal(classifyCommandSemantics('sudo npm publish'), 'deploy');
  assert.equal(classifyCommandSemantics('bash -c "git push -f origin main"'), 'git_push');
  assert.equal(classifyCommandSemantics('powershell -Command "Remove-Item -Recurse C:\\x"'), 'delete_destructive');
});
