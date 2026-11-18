#!/usr/bin/env node
/**
 * Static import-graph audit for the CLI source tree.
 *
 * Reports module and relative-edge counts, then every cyclic strongly connected
 * component (Tarjan) over static `import`/`export … from` and literal dynamic
 * `import()` edges. Two graphs are reported:
 *
 *   source — every static relative edge, including `import type`
 *   value  — static relative edges that survive type erasure (plain `import
 *            type` / `export type` statements are excluded; inline `{ type X }`
 *            specifiers stay counted, so this is conservative)
 *
 * It is a structural measurement, not proof of runtime independence: path
 * strings, worker spawning and bare package imports are out of scope. Used by
 * the W14 maintainability review to recheck AR-01. Pass `--strict` to exit 1
 * when a value cycle exists; the default report exits 0 so it can be recorded
 * without turning a known structural debt into a failing workspace command.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const srcRoot = join(repoRoot, 'babel-cli', 'src')

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full)
  }
  return files
}

const files = walk(srcRoot)
const known = new Set(files)
const sourceGraph = new Map()
const valueGraph = new Map()

function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const target = resolve(dirname(from), specifier.replace(/\.js$/, '.ts'))
  if (known.has(target)) return target
  const indexTarget = join(resolve(dirname(from), specifier), 'index.ts')
  if (known.has(indexTarget)) return indexTarget
  return undefined
}

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const sources = new Set()
  const values = new Set()
  const patterns = [
    /(?:import|export)[^'"();]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = resolveSpecifier(file, match[1])
      if (!target || target === file) continue
      sources.add(target)
      if (!/^\s*(?:import|export)\s+type\s/.test(match[0])) values.add(target)
    }
  }
  sourceGraph.set(file, [...sources])
  valueGraph.set(file, [...values])
}

function findCycles(graph) {
  let nextIndex = 0
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  function strongConnect(node) {
    index.set(node, nextIndex)
    low.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)
    for (const dep of graph.get(node) ?? []) {
      if (!index.has(dep)) {
        strongConnect(dep)
        low.set(node, Math.min(low.get(node), low.get(dep)))
      } else if (onStack.has(dep)) {
        low.set(node, Math.min(low.get(node), index.get(dep)))
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      if (component.length > 1) components.push(component)
    }
  }

  for (const file of files) if (!index.has(file)) strongConnect(file)
  return components.sort((a, b) => b.length - a.length)
}

function edgeCount(graph) {
  return [...graph.values()].reduce((sum, deps) => sum + deps.length, 0)
}

function report(label, components) {
  console.log(`${label} cycles=${components.length}`)
  for (const component of components) {
    console.log(`  cycle (${component.length} modules):`)
    for (const member of component.sort()) {
      console.log(`    ${relative(repoRoot, member).replace(/\\/g, '/')}`)
    }
  }
}

const sourceCycles = findCycles(sourceGraph)
const valueCycles = findCycles(valueGraph)

console.log(
  `modules=${files.length} sourceEdges=${edgeCount(sourceGraph)} valueEdges=${edgeCount(valueGraph)}`,
)
report('source', sourceCycles)
report('value', valueCycles)

process.exit(process.argv.includes('--strict') && valueCycles.length > 0 ? 1 : 0)
