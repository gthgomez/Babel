/** Black-box values are validated in the host, outside candidate execution. */
import { gradeInCleanRoom } from './cleanRoomGrade.js'
import { spawnSync } from 'node:child_process'
import { posix } from 'node:path'
import ts from 'typescript'
import { capturedText, type JourneyOutputReader } from './harness-journey-checks.js'

type Call = { path: string; name: string; args: unknown[] }
const cases: Record<string, { paths: string[]; calls: Call[]; expected: unknown[] }> = {
  J04: {
    paths: ['lib/invoice.mjs', 'app/customer.mjs', 'app/admin.mjs'],
    calls: [1234, 1, 0].map(cents => ({ path: 'lib/invoice.mjs', name: 'invoice', args: [cents] })).concat([
      { path: 'app/customer.mjs', name: 'due', args: [] }, { path: 'app/admin.mjs', name: 'due', args: [] },
    ]),
    expected: [{ value: '12.34' }, { value: '0.01' }, { value: '0.00' }, { value: '12.34' }, { value: '50.00' }],
  },
  J05: {
    paths: ['lib/total.mjs'],
    calls: [[{ price: 2, quantity: 3 }, { price: 5, quantity: 2 }], [], [{ price: 20, quantity: 0 }]].map(items => ({ path: 'lib/total.mjs', name: 'total', args: [items] })),
    expected: [{ value: 16 }, { value: 0 }, { value: 0 }],
  },
  J06: {
    paths: ['lib/invoice.mjs'],
    calls: [[{ price: 19.99, quantity: 3 }], [], [{ price: 1, quantity: -1 }]].map(items => ({ path: 'lib/invoice.mjs', name: 'invoiceTotal', args: [items] })),
    expected: [{ value: 53.97 }, { value: 0 }, { threw: true }],
  },
}

/** Pinned Docker contains execution; a closed VM realm separates measurement I/O. */
export async function gradeJourneyCode(id: string, read: JourneyOutputReader, image?: string): Promise<'pass' | 'fail' | 'unavailable'> {
  const oracle = cases[id]
  if (!oracle || !image) return 'unavailable'
  if (!/^[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}$/.test(image)) return 'unavailable'
  const installed = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (installed.error || installed.status !== 0) return 'unavailable'
  const files: { relativePath: string; contents: string }[] = []
  const pending = [...oracle.paths]
  const seen = new Set<string>()
  let totalBytes = 0
  // Parse dependencies without executing them. Only safe captured relative ESM
  // files enter this synchronous computational oracle; other envelopes remain
  // unavailable rather than silently dropping a valid candidate dependency.
  while (pending.length) {
    const path = pending.shift()!
    if (seen.has(path)) continue
    seen.add(path)
    if (seen.size > 64 || !/\.(?:mjs|js)$/.test(path)) return 'unavailable'
    const output = await capturedText(read, path)
    if (!output) return 'fail'
    totalBytes += Buffer.byteLength(output.text)
    if (totalBytes > 4_194_304) return 'unavailable'
    files.push({ relativePath: path, contents: output.text })
    let dynamicImport = false
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true
      ts.forEachChild(node, inspect)
    }
    try { inspect(ts.createSourceFile(path, output.text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)) } catch { return 'unavailable' }
    if (dynamicImport) return 'unavailable'
    for (const dependency of ts.preProcessFile(output.text, true, true).importedFiles) {
      if (!dependency.fileName.startsWith('./') && !dependency.fileName.startsWith('../')) return 'unavailable'
      const resolved = posix.normalize(posix.join(posix.dirname(path), dependency.fileName))
      if (resolved.startsWith('../') || posix.isAbsolute(resolved)) return 'fail'
      pending.push(resolved)
    }
  }
  // Docker is the OS boundary, not node:vm. Candidate modules receive no host
  // functions/objects, process, filesystem, stdout, dynamic loader or expected
  // answers. Trusted serialization stays in the outer container worker. Never
  // await a returned candidate thenable or stringify a candidate object there.
  const worker = `import vm from 'node:vm'
import {posix} from 'node:path'
const sources = new Map(${JSON.stringify(files.map(file => [file.relativePath, file.contents]))})
const calls = ${JSON.stringify(oracle.calls)}
const results = []
for (const call of calls) {
  try {
    const context = vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}, microtaskMode:'afterEvaluate'})
    vm.runInContext('delete globalThis.console', context)
    const modules = new Map()
    function getModule(path) {
      if (!sources.has(path)) throw Error('Uncaptured module')
      if (!modules.has(path)) modules.set(path, new vm.SourceTextModule(sources.get(path), {context,identifier:path}))
      return modules.get(path)
    }
    const linker = (specifier, parent) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw Error('Unsupported module')
      const path = posix.normalize(posix.join(posix.dirname(parent.identifier), specifier))
      return getModule(path)
    }
    const measurement = new vm.SourceTextModule('import {' + call.name + ' as measured} from ' + JSON.stringify('./' + call.path) + '; export const value = measured(' + call.args.map(arg => JSON.stringify(arg)).join(',') + ')', {context,identifier:'__measurement__.mjs'})
    await measurement.link(linker)
    await measurement.evaluate({timeout:1000})
    const value = measurement.namespace.value
    results.push((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' ? {value} : {unsupported_type:true})
  } catch { results.push({threw:true}) }
}
process.stdout.write(JSON.stringify(results))
`
  try {
    const result = gradeInCleanRoom({ startFiles: [], candidateDiffFiles: files,
      oracleFiles: [{ relativePath: 'capture-values.mjs', contents: worker }],
      verifierCommand: ['node', '--experimental-vm-modules', 'capture-values.mjs'], execution: { kind: 'docker', image },
    })
    if (result.execution_status !== 'completed') return 'unavailable'
    if (result.exit_code !== 0) return 'fail'
    try {
      const observed: unknown = JSON.parse(result.stdout)
      if (Array.isArray(observed) && observed.some(value => value?.unsupported_type === true)) return 'unavailable'
      return JSON.stringify(observed) === JSON.stringify(oracle.expected) ? 'pass' : 'fail'
    } catch { return 'fail' }
  } catch { return 'unavailable' }
}
