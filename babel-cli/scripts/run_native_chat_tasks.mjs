/** Explicit execution, separate from the existing offline journey preparation. */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { values } = parseArgs({ options: {
  out: { type: 'string' }, mode: { type: 'string' }, 'code-image': { type: 'string' },
  model: { type: 'string' },
}, strict: true, allowPositionals: false })
if (!values.out || !['calibration', 'live'].includes(values.mode ?? '')) throw new Error('Usage: node --import tsx scripts/run_native_chat_tasks.mjs --mode calibration|live --out <new-directory> [--code-image <local-image@sha256:...>] [--model <approved-model>]')
const options = {
  out: values.out, mode: values.mode,
  ...(values['code-image'] ? { codeImage: values['code-image'] } : {}),
  ...(values.model ? { model: values.model } : {}),
}
if (values.mode === 'calibration') {
  // Isolate credentials, home/config and ambient experiment flags before
  // importing Babel. Only this fresh process receives fixture approval flags.
  const home = await mkdtemp(join(tmpdir(), 'babel-native-home-'))
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'const {runNativeChatTasks}=await import(process.argv[1]); console.log(JSON.stringify(await runNativeChatTasks(JSON.parse(process.argv[2])),null,2))',
    new URL('../src/eval/native-chat-tasks.ts', import.meta.url).href, JSON.stringify(options)], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home },
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  process.stdout.write(child.stdout ?? '')
  process.stderr.write(child.stderr ?? '')
  process.exitCode = child.status ?? 1
} else {
  const { runNativeChatTasks } = await import('../src/eval/native-chat-tasks.ts')
  console.log(JSON.stringify(await runNativeChatTasks(options), null, 2))
}
