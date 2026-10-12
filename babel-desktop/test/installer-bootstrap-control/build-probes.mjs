// License: Apache-2.0
// Writes NSIS probe scripts for Windows bootstrap control-flow qualification.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {renderBootstrapProbeNsi} from '../../scripts/package-windows-setup.mjs';

const workRoot = process.argv[2];
if (!workRoot) throw new Error('Usage: node build-probes.mjs <workRoot>');

mkdirSync(workRoot, {recursive: true});
writeFileSync(join(workRoot, 'exit0.cmd'), '@echo off\r\nexit /b 0\r\n');
writeFileSync(join(workRoot, 'exit7.cmd'), '@echo off\r\nexit /b 7\r\n');

const probes = [
  {id: 'fixed-success', style: 'named', stub: 'exit0.cmd', launchFailure: false},
  {id: 'fixed-exit7', style: 'named', stub: 'exit7.cmd', launchFailure: false},
  {id: 'fixed-launch-fail', style: 'named', stub: 'exit0.cmd', launchFailure: true},
  {id: 'legacy-exit7-negative', style: 'legacyOffset', stub: 'exit7.cmd', launchFailure: false},
];

const manifest = [];
for (const probe of probes) {
  const outFile = join(workRoot, `${probe.id}.exe`);
  const nsiPath = join(workRoot, `${probe.id}.nsi`);
  const nsi = renderBootstrapProbeNsi({
    ifErrorsStyle: probe.style,
    stagedBootstrap: join(workRoot, probe.stub),
    outFile,
    launchFailure: probe.launchFailure,
  });
  writeFileSync(nsiPath, nsi.endsWith('\n') ? nsi : `${nsi}\n`);
  manifest.push({...probe, nsiPath, outFile});
}
writeFileSync(join(workRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
