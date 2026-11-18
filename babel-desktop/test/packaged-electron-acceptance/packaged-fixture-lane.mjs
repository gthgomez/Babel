// License: Apache-2.0
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {inspectProjectIdentity} from '../../native/project-authority.mjs';
import {createRepairFixture} from './packaged-repair-fixture.mjs';

export const MISSING_INSTALL_ID = 'acceptance-missing-install';
export const HISTORY_SESSION_ID = 'packaged-history';
export const PROJECT_DIR_NAME = 'acceptance-project';

/** Installed acceptance cannot qualify an unknown or mismatched BUILD source. */
export function assertAcceptanceSource(build, expectedSha = '') {
  if (!/^[a-f0-9]{40}$/.test(build?.sourceSha ?? '')) throw new Error('Installed BUILD source is missing or invalid');
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('An exact expected source SHA is required');
  if (build.sourceSha !== expectedSha) throw new Error('Installed source does not match requested source');
}

/** A successful task needs one consistent terminal and an intact transport exit. */
export function assertFixtureTaskReceipt(events, expectedOutcome) {
  const terminals = events.filter(event => event.kind === 'event' &&
    ['run_complete', 'turn.completed', 'run_error', 'turn.failed', 'cancelled'].includes(event.type));
  const exits = events.filter(event => event.kind === 'exit');
  if (terminals.length !== 1 || terminals[0].type !== 'run_complete' ||
      terminals[0].outcome !== expectedOutcome || terminals[0].userStatus !== 'completed' ||
      (terminals[0].verification !== undefined && terminals[0].verification !== 'verified') ||
      terminals[0].approvalRequired === true || exits.length !== 1 || exits[0].code !== 0 ||
      exits[0].displayLimited !== false || events.some(event => event.kind === 'transport-error')) {
    throw new Error('fixture task terminal or transport receipt is inconsistent');
  }
}

/** Distinguish the read-only policy denial from unrelated filesystem failures. */
export function assertReadOnlyDenial(events) {
  if (!events.some(event => event.type === 'tool.failed' && event.tool === 'str_replace' &&
      /hard-plan-mode|read[ -]only/i.test(event.detail ?? ''))) {
    throw new Error('read-only edit attempt was not denied by the read-only policy');
  }
}

/** Give the installed process only OS launch paths and disposable user directories. */
export function buildPackagedLaunchEnvironment(inherited, profile) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const key = Object.keys(inherited).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && inherited[key]) env[name] = inherited[key];
  }
  return {...env, HOME: profile, USERPROFILE: profile, APPDATA: join(profile, 'launch-config'),
    LOCALAPPDATA: join(profile, 'launch-state'), TEMP: join(profile, 'launch-temp'), TMP: join(profile, 'launch-temp'),
    BABEL_OPENCODE_GO_HELPER: join(profile, 'absent-fixture-helper.cjs')};
}

/** Seed non-paid fixtures under an isolated Electron profile directory (Windows packaged lane). */
export async function writePackagedAcceptanceProfile(profile) {
  const projectRoot = join(profile, PROJECT_DIR_NAME);
  const runsRoot = join(profile, 'engine', 'state', 'runs', 'chat-sessions', HISTORY_SESSION_ID);
  for (const dir of ['launch-config', 'launch-state', 'launch-temp']) await mkdir(join(profile, dir), {recursive: true});
  await createRepairFixture(projectRoot);
  await mkdir(runsRoot, {recursive: true});
  const configRoot=join(profile,'engine','config');
  await mkdir(configRoot,{recursive:true});
  await writeFile(join(configRoot,'desktop-model-catalog.json'),JSON.stringify({models:[{
    id:'ollama/local-fixture',modelId:'local-fixture',provider:'ollama',label:'Local acceptance fixture',enabled:false,
  }]})+'\n','utf8');
  const lines = [];
  lines.push(JSON.stringify({role: 'user', content: 'PACKAGED-HISTORY-FIXTURE'}));
  for (let i = 1; i < 160; i += 1) {
    lines.push(JSON.stringify({role: i % 2 === 0 ? 'user' : 'assistant', content: `m-${String(i).padStart(3, '0')}`}));
  }
  await writeFile(join(runsRoot, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf8');
  await writeFile(join(profile, 'ui-connection.json'), JSON.stringify({
    cliEntry: null,
    projectRoot,
    projectCredentialRoot: null,
  }) + '\n', 'utf8');
  const identity = await inspectProjectIdentity(projectRoot);
  // Preauthorized installed-profile fixture only — does not exercise the user-grant UI.
  await writeFile(join(profile, 'project-authority.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    grants: [{ identity, revision: 1, grantedAt: new Date().toISOString(), fixture: 'packaged-preauthorized-grant' }],
  }) + '\n', 'utf8');
  await writeFile(join(profile, 'engine', 'active-engine.json'), JSON.stringify({id: MISSING_INSTALL_ID, channelPreference: 'stable'}) + '\n', 'utf8');
  return {projectRoot, runsRoot, missingInstallId: MISSING_INSTALL_ID};
}
