import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayloadBuild, parseSha256Sums, renderNsis, compileNsis } from '../scripts/package-windows-setup.mjs';

const validBuild = {platform: 'win32-x64', signed: false, version: '0.1.1', sourceSha: 'a'.repeat(40)};
const B = String.fromCharCode(92); // path backslash, kept out of string escapes

test('archive compiler stays available through artifact recording, then is removed', () => {
  const events = [];
  const result = compileNsis(
    {makensis: 'archive/makensis.exe', script: 'setup.nsi', useArchive: true, nsisExtract: 'archive'},
    (exe, args) => events.push(['compile', exe, args]),
    () => { events.push(['record']); return 'sha'; },
    (path, options) => events.push(['cleanup', path, options]),
  );
  assert.equal(result, 'sha');
  assert.deepEqual(events.map(event => event[0]), ['compile', 'record', 'cleanup']);
  assert.deepEqual(events[2], ['cleanup', 'archive', {recursive: true, force: true}]);
});

test('external compiler is not removed after artifact recording', () => {
  const events = [];
  compileNsis(
    {makensis: 'system/makensis.exe', script: 'setup.nsi', useArchive: false},
    () => events.push('compile'),
    () => events.push('record'),
    () => events.push('cleanup'),
  );
  assert.deepEqual(events, ['compile', 'record']);
});

test('archive cleanup runs when compilation fails', () => {
  const events = [];
  assert.throws(() => compileNsis(
    {makensis: 'archive/makensis.exe', script: 'setup.nsi', useArchive: true, nsisExtract: 'archive'},
    () => { throw new Error('compile failed'); },
    () => assert.fail('failed compilation cannot record artifacts'),
    path => events.push(path),
  ), /compile failed/);
  assert.deepEqual(events, ['archive']);
});

test('cleanup failure does not mask the original compile error', () => {
  assert.throws(() => compileNsis(
    {makensis: 'archive/makensis.exe', script: 'setup.nsi', useArchive: true, nsisExtract: 'archive'},
    () => { throw new Error('compile failed'); },
    () => assert.fail('unreachable'),
    () => { throw new Error('EBUSY: resource busy or locked'); },
  ), /compile failed/);
});

test('cleanup failure with no primary error still fails the build', () => {
  assert.throws(() => compileNsis(
    {makensis: 'archive/makensis.exe', script: 'setup.nsi', useArchive: true, nsisExtract: 'archive'},
    () => {},
    () => 'sha',
    () => { throw new Error('EBUSY: resource busy or locked'); },
  ), /EBUSY/);
});

test('payload gate accepts stable and preview versions on unsigned win32-x64', () => {
  assert.equal(validatePayloadBuild({...validBuild, version: '0.1.1'}), '0.1.1');
  assert.equal(validatePayloadBuild({...validBuild, version: '0.1.1-preview.20261004'}), '0.1.1-preview.20261004');
});

test('payload gate rejects non-Windows, signed, or malformed-version payloads', () => {
  assert.throws(() => validatePayloadBuild({...validBuild, platform: 'darwin'}), /win32-x64/);
  assert.throws(() => validatePayloadBuild({...validBuild, signed: true}), /signed/);
  assert.throws(() => validatePayloadBuild({...validBuild, version: '0.1.1-rc1'}), /version/);
  assert.throws(() => validatePayloadBuild({...validBuild, version: '1.2'}), /version/);
  assert.throws(() => validatePayloadBuild({...validBuild, version: '1.2.3-preview.2026'}), /version/);
});

test('SHA256SUMS parser reads the binary-hash entry and tolerates the * marker', () => {
  const text = [
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  other.zip',
    'abc123 *Babel-Desktop-0.1.1-win-x64.zip',
  ].join('\r\n');
  assert.equal(parseSha256Sums(text, 'Babel-Desktop-0.1.1-win-x64.zip'), 'abc123');
  assert.throws(() => parseSha256Sums(text, 'missing.zip'), /no entry/);
});

test('NSIS script is per-user, silent-capable, and runs the qualified installer', () => {
  const nsi = renderNsis({
    version: '0.1.1',
    stagedPayload: `C:${B}stage${B}Babel-Desktop-payload.zip`,
    stagedSha: `C:${B}stage${B}payload.sha256`,
    stagedInstall: `C:${B}stage${B}install-windows.ps1`,
    stagedUninstall: `C:${B}stage${B}uninstall-windows.ps1`,
    stagedBootstrap: `C:${B}stage${B}run-install.cmd`,
    outFile: `C:${B}out${B}Babel-Desktop-Setup-0.1.1-win-x64.exe`,
  });
  assert.match(nsi, /RequestExecutionLevel user/, 'must not request elevation');
  assert.match(nsi, /SilentInstall normal/, 'must support /S silent installs');
  assert.ok(nsi.includes(`OutFile "C:${B}out${B}Babel-Desktop-Setup-0.1.1-win-x64.exe"`));
  assert.match(nsi, /File \/oname=Babel-Desktop-payload\.zip "C:/);
  assert.match(nsi, /install-windows\.ps1/, 'must run the qualified PowerShell installer');
  assert.match(nsi, /SetErrorLevel \$R0/, 'must propagate installer failure exit codes');
  assert.doesNotMatch(nsi, /iexpress/i, 'the abandoned IExpress approach must not return');
  assert.doesNotMatch(nsi, /RequireAdmin|SetShellVarContext all/, 'must not install machine-wide');
});

test('NSIS script quotes Windows paths containing spaces', () => {
  const spaced = `C:${B}Program Files${B}Space Dir${B}payload.zip`;
  const nsi = renderNsis({
    version: '1.2.3',
    stagedPayload: spaced,
    stagedSha: `C:${B}s`, stagedInstall: `C:${B}i`, stagedUninstall: `C:${B}u`,
    outFile: `C:${B}o${B}setup.exe`,
  });
  assert.ok(nsi.includes(`"${spaced}"`), 'the spaced path must appear quoted verbatim');
});
