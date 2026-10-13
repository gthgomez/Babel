// License: Apache-2.0 — see LICENSE
import {mkdtemp, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {_electron as electron} from 'playwright';
import {parseBuildMetadata} from '../../native/identity.mjs';
import {assertAcceptanceSource} from './packaged-fixture-lane.mjs';

async function main() {
  if (process.platform !== 'win32') throw new Error('Native project picker requires Windows');
  const install = process.env.BABEL_DESKTOP_INSTALL_ROOT;
  const artifacts = process.env.BABEL_DESKTOP_ACCEPTANCE_DIR;
  if (!install || !artifacts) throw new Error('Install root and acceptance directory are required');
  await mkdir(artifacts, {recursive: true});
  const report = {passed: false, sourceSha: null, transport: 'Installed Electron preload/main + PID-scoped Windows UI Automation native folder dialog', errors: []};
  let app;
  let controller;
  try {
    const profile = await mkdtemp(join(tmpdir(), 'babel-native-picker-'));
    const project = join(profile, 'native-selected-project');
    await mkdir(project);
    await writeFile(join(project, 'README.md'), '# Native picker fixture\n');
    const build = parseBuildMetadata(await readFile(join(install, 'BUILD.json'), 'utf8'));
    assertAcceptanceSource(build, process.env.BABEL_DESKTOP_SOURCE_SHA ?? '');
    report.sourceSha = build.sourceSha;
    app = await electron.launch({executablePath: join(install, 'Babel Desktop.exe'), args: [`--profile-dir=${profile}`], timeout: 120_000});
    const window = await app.firstWindow();
    window.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
    await window.locator('#dialog[open]').waitFor({timeout: 60_000});
    const initial = await window.evaluate(() => window.babelDesktop.getInfo());
    if (initial.packaged !== true || initial.engine?.source?.commitSha !== build.sourceSha || initial.projectName !== null) throw new Error('Fresh installed picker profile identity mismatch');
    controller = spawn('pwsh', ['-NoProfile', '-File', join(dirname(fileURLToPath(import.meta.url)), 'select-native-project.ps1'), '-ElectronProcessId', String(app.process().pid), '-ProjectRoot', project], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    controller.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16_000); });
    const completion = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        controller.kill();
        reject(new Error('Owned picker controller exceeded 60 seconds'));
      }, 60_000);
      controller.once('error', error => { clearTimeout(deadline); reject(error); });
      controller.once('exit', code => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`Owned picker controller exited ${code}: ${stderr}`));
      });
    });
    // Register handling before renderer click; retain the rejecting promise for await.
    completion.catch(() => {});
    await window.locator('#dialog [data-action="open-project"]').click();
    await completion;
    await window.waitForFunction(async () => (await window.babelDesktop.getInfo()).projectName === 'native-selected-project', null, {timeout: 30_000});
    const saved = JSON.parse(await readFile(join(profile, 'ui-connection.json'), 'utf8'));
    if (typeof saved.projectRoot !== 'string' || (await realpath(saved.projectRoot)).toLowerCase() !== (await realpath(project)).toLowerCase()) throw new Error('Native selected project was not persisted');
    const names = await window.evaluate(async () => (await window.babelDesktop.listDirectory('.')).map(entry => entry.name));
    if (!names.includes('README.md')) throw new Error('Real native directory IPC did not read the selected fixture');
    await window.screenshot({path: join(artifacts, 'native-project-picker.png'), fullPage: true});
    report.passed = report.errors.length === 0;
  } catch (error) { report.errors.push(String(error?.message ?? error)); }
  finally {
    if (controller && controller.exitCode === null && controller.signalCode === null) controller.kill();
    if (app) {
      try { await app.close(); } catch (error) { report.errors.push(`Owned app cleanup: ${error.message}`); report.passed = false; }
    }
    report.passed = report.passed && report.errors.length === 0;
    await writeFile(join(resolve(artifacts), 'native-project-picker.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
