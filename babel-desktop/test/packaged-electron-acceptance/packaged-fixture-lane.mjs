// License: Apache-2.0
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const MISSING_INSTALL_ID = 'acceptance-missing-install';
export const HISTORY_SESSION_ID = 'packaged-history';
export const PROJECT_DIR_NAME = 'acceptance-project';

/** Installed acceptance cannot qualify an unknown or mismatched BUILD source. */
export function assertAcceptanceSource(build, expectedSha = '') {
  if (!/^[a-f0-9]{40}$/.test(build?.sourceSha ?? '')) throw new Error('Installed BUILD source is missing or invalid');
  if (expectedSha && build.sourceSha !== expectedSha) throw new Error('Installed source does not match requested source');
}

/** Seed non-paid fixtures under an isolated Electron profile directory (Windows packaged lane). */
export async function writePackagedAcceptanceProfile(profile) {
  const projectRoot = join(profile, PROJECT_DIR_NAME);
  const runsRoot = join(profile, 'engine', 'state', 'runs', 'chat-sessions', HISTORY_SESSION_ID);
  await mkdir(projectRoot, {recursive: true});
  await mkdir(runsRoot, {recursive: true});
  await writeFile(join(projectRoot, 'README.md'), '# Packaged acceptance fixture\n', 'utf8');
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
  await writeFile(join(profile, 'engine', 'active-engine.json'), JSON.stringify({id: MISSING_INSTALL_ID, channelPreference: 'stable'}) + '\n', 'utf8');
  return {projectRoot, runsRoot, missingInstallId: MISSING_INSTALL_ID};
}
