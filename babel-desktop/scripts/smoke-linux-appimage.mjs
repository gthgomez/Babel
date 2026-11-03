// License: Apache-2.0
// Prove a packaged Linux AppImage opens a window on the current DISPLAY.
// Tries the default sandbox first. If that process exits before a window
// appears, retries with extract-and-run and, if needed, --no-sandbox.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

function windowVisible() {
  const listed = spawnSync('xwininfo', ['-root', '-tree'], {encoding: 'utf8'});
  return listed.status === 0 && /Babel/.test(listed.stdout ?? '');
}

function finished(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, ms) {
  if (finished(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(finished(child)), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Stop an AppImage process group. Electron children inherit the smoke
 * process's pipes, so killing only the direct child leaves Node waiting
 * until the CI job times out.
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 */
export async function stopProcessTree(child) {
  if (!child) return;
  const signal = name => {
    if (finished(child)) return;
    try { process.kill(-child.pid, name); }
    catch { try { child.kill(name); } catch { /* The process is already gone. */ } }
  };
  if (!finished(child)) signal('SIGTERM');
  if (!await waitForExit(child, 2000)) signal('SIGKILL');
  await waitForExit(child, 2000);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function attempt(appimage, mode) {
  const profile = mkdtempSync(join(tmpdir(), 'babel-desktop-smoke-'));
  const chunks = [];
  const child = spawn(appimage, [`--profile-dir=${profile}`, ...mode.args], {
    env: {...process.env, ...mode.env},
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  let exited = null;
  child.on('exit', code => { exited = code; });
  const started = Date.now();
  let seen = false;
  while (Date.now() - started < 30000) {
    if (exited !== null) break;
    if (windowVisible()) { seen = true; break; }
    await delay(500);
  }
  const log = Buffer.concat(chunks).toString('utf8').slice(-8000);
  if (!seen) await stopProcessTree(child);
  return {child: seen ? child : null, seen, exited, log, profile};
}

async function capture(child, screenshot, width, height) {
  mkdirSync(dirname(screenshot), {recursive: true});
  const shot = spawnSync('ffmpeg', ['-y', '-f', 'x11grab', '-video_size', `${width}x${height}`, '-i', process.env.DISPLAY, '-frames:v', '1', screenshot], {encoding: 'utf8'});
  await stopProcessTree(child);
  return shot.status === 0;
}

async function main() {
  const appimage = option('appimage');
  const screenshot = option('screenshot');
  const resultPath = option('result');
  if (!appimage || !screenshot) {
    console.error('Usage: node scripts/smoke-linux-appimage.mjs --appimage=<path> --screenshot=<path> [--result=<path>]');
    return 1;
  }
  if (!process.env.DISPLAY) {
    console.error('DISPLAY is required. Run under xvfb-run or an existing X server.');
    return 1;
  }
  const rootSize = spawnSync('xwininfo', ['-root'], {encoding: 'utf8'});
  const width = Number(/Width:\s+(\d+)/.exec(rootSize.stdout ?? '')?.[1] ?? 0);
  const height = Number(/Height:\s+(\d+)/.exec(rootSize.stdout ?? '')?.[1] ?? 0);
  if (rootSize.status !== 0 || width < 640 || height < 480) {
    console.error('xwininfo could not read the X root window. Install x11-utils and use a real DISPLAY.');
    return 1;
  }
  const modes = [
    {name: 'default-sandbox', env: {}, args: ['--disable-gpu', '--disable-dev-shm-usage']},
    {name: 'extract-and-run', env: {APPIMAGE_EXTRACT_AND_RUN: '1'}, args: ['--disable-gpu', '--disable-dev-shm-usage']},
    {name: 'extract-and-run-no-sandbox', env: {APPIMAGE_EXTRACT_AND_RUN: '1'}, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']},
  ];
  const attempts = [];
  let outcome = {ok: false, mode: null, screenshot: null, screen: {width, height}, attempts};
  for (const mode of modes) {
    const result = await attempt(appimage, mode);
    attempts.push({mode: mode.name, windowSeen: result.seen, exitCode: result.exited});
    if (!result.seen) {
      if (result.log.trim()) console.error(result.log.slice(-2000));
      continue;
    }
    const captured = await capture(result.child, screenshot, width, height);
    outcome = {ok: captured, mode: mode.name, screenshot: captured ? screenshot : null, screen: {width, height}, attempts};
    break;
  }
  if (resultPath) writeFileSync(resultPath, JSON.stringify(outcome, null, 2) + '\n');
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const code = await main();
  process.exit(code);
}
