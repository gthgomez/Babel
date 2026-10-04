import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSha256Manifest, renderIExpressSed, validatePayloadBuildMetadata } from '../scripts/package-windows-setup.mjs';

test('IExpress package launches the per-user bootstrap from paths containing spaces', () => {
  const sed = renderIExpressSed({
    targetName: 'C:\\Build Root\\Desktop Builds\\Babel Desktop Setup.exe',
    sourceDirectory: 'C:\\Build Root\\Desktop Builds\\staging',
    friendlyName: 'Babel Desktop Setup',
  });

  assert.match(sed, /ExtractOnly=0/);
  assert.match(sed, /CheckAdminRights=0/);
  assert.match(sed, /AppLaunched=powershell\.exe -NoProfile -ExecutionPolicy Bypass -File install\.ps1/);
  assert.match(sed, /UserQuietInstCmd=powershell\.exe -NoProfile -ExecutionPolicy Bypass -File install\.ps1/);
  assert.match(sed, /TargetName=C:\\Build Root\\Desktop Builds\\Babel Desktop Setup\.exe/);
  assert.match(sed, /SourceFiles0=C:\\Build Root\\Desktop Builds\\staging/);
  assert.match(sed, /FILE0="Babel-Desktop-payload\.zip"/);
  assert.match(sed, /%FILE0%=\r\n%FILE1%=\r\n%FILE2%=\r\n%FILE3%=/);
  assert.match(sed, /FILE1="payload\.sha256"/);
  assert.match(sed, /FILE2="install\.ps1"/);
  assert.match(sed, /FILE3="uninstall-windows\.ps1"/);
  assert.doesNotMatch(sed, /AdminQuietInstCmd=/);
});

test('SHA256SUMS parser accepts the named payload and rejects a different file', () => {
  const manifest = `${'a'.repeat(64)}  Babel-Desktop-payload.zip\n`;
  assert.equal(parseSha256Manifest(manifest, 'Babel-Desktop-payload.zip'), 'a'.repeat(64));
  assert.throws(() => parseSha256Manifest(manifest, 'other.zip'), /expected exactly one checksum/);
  assert.throws(() => parseSha256Manifest(`oops  Babel-Desktop-payload.zip\n`, 'Babel-Desktop-payload.zip'), /invalid SHA256/);
});

test('portable payload metadata rejects unsupported versions before packaging', () => {
  const metadata = {
    platform:'win32-x64',
    signed:false,
    sourceSha:'a'.repeat(40),
    version:'0.1.1-preview.20261004',
  };

  assert.equal(validatePayloadBuildMetadata(metadata), metadata);
  assert.throws(() => validatePayloadBuildMetadata({...metadata, version:'not-a-preview'}), /supported, unsigned/);
});
