/** Stage only public runtime resources; prompt_catalog.yaml marks the installed layout. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const repoRoot = resolve(process.argv[2] ?? resolve(packageRoot, '..'))
const resources = resolve(packageRoot, 'resources')
const catalog = readFileSync(resolve(repoRoot, 'prompt_catalog.yaml'), 'utf8')
// Catalog paths are scalar, repo-relative paths. Reject traversal rather than copying outside the checkout.
const assets = new Set(['prompt_catalog.yaml'])
for (const match of catalog.matchAll(/^\s+path:\s*([^\r\n#]+?)(?:\s+#.*)?$/gm)) {
  assets.add(match[1].trim().replace(/^['"]|['"]$/g, ''))
}
for (const dir of ['07_Pipeline_Stages', 'prompts', 'LLM_COLLABORATION_SYSTEM']) {
  const source = resolve(repoRoot, dir)
  if (!existsSync(source)) continue
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:json|md)$/.test(entry.name)) assets.add(`${dir}/${entry.name}`)
  }
}
for (const file of [
  'config/model-policy.json', 'config/purpose-mode-seeds.json', 'config/review-risk-policy.json',
  'config/runtime-flags.json', 'config/independent-review-keys.json', 'config/trusted-supervisor-keys.json',
  'babel-cli/config/enterprise-policy.example.json', 'babel-cli/config/mcp_servers.json',
  'babel-cli/config/plugins.json', 'babel-cli/config/runtime-mode.json',
  'INTEGRATION.md', 'PROJECT_CONTEXT.md', 'docs/architecture/HARNESS_ARCHITECTURE_V1.md',
]) {
  if (existsSync(resolve(repoRoot, file))) assets.add(file)
}
// Validate everything before replacing generated resources, so missing catalog assets fail closed.
for (const asset of assets) {
  const rel = relative(repoRoot, resolve(repoRoot, asset))
  if (isAbsolute(asset) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Unsafe runtime asset: ${asset}`)
  if (!existsSync(resolve(repoRoot, asset))) throw new Error(`Missing runtime asset: ${asset}`)
}
rmSync(resources, { recursive: true, force: true })
for (const asset of assets) {
  const target = resolve(resources, asset)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(resolve(repoRoot, asset), target)
}
copyFileSync(resolve(repoRoot, 'LICENSE'), resolve(packageRoot, 'LICENSE'))
// Ordinary contributor builds retain declarations/maps; only the prepack build is pruned.
function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      if (['__snapshots__', 'testinfra'].includes(entry.name)) rmSync(path, { recursive: true })
      else prune(path)
    } else if (/\.test\.[cm]?js$|\.map$|\.d\.[cm]?ts$|\.tsbuildinfo$/.test(entry.name)) rmSync(path)
  }
}
prune(resolve(packageRoot, 'dist'))
console.log(`Staged ${assets.size} runtime assets in resources/`)
