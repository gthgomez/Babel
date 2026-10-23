// License: Apache-2.0 — see LICENSE
import { spawn, spawnSync } from 'node:child_process'

/** Read immutable tree metadata. No checkout, filters, archive attributes or candidate code. */
export function readCommittedInventory(root, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('exact committed identity required')
  const result = spawnSync('git', ['-C', root, 'ls-tree', '-rlz', '--full-tree', sha], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('committed inventory unavailable')
  const inventory = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d{6}) (blob|commit) ([a-f0-9]{40})\s+(-|\d+)\t([\s\S]+)$/)
    if (!match) throw new Error('invalid committed inventory')
    const [, mode, type, oid, size, path] = match
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw new Error('unscannable committed object')
    if (!path || /^[\\/]/.test(path) || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe committed path')
    if (path.split('/').some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('nonportable committed path')
    const folded = path.toLowerCase()
    const leaf = folded.split('/').at(-1)
    if (leaf === '.env' || (leaf.startsWith('.env.') && leaf !== '.env.example') || /(^|\/)\.codex\/(auth\.json|\.env)$/.test(folded) ||
        /(^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|secrets)\//.test(folded) || /\.(?:pem|p12|pfx|key)$/.test(folded)) throw new Error('credential-class committed path rejected before export')
    if (!Number.isSafeInteger(Number(size)) || Number(size) > 20 * 1024 * 1024) throw new Error('committed file size limit exceeded')
    return { path, mode, oid, size: Number(size) }
  })
  const files = new Set(), directories = new Set()
  for (const entry of inventory) {
    const path = entry.path.toLowerCase()
    if (files.has(path) || directories.has(path)) throw new Error('colliding committed path')
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      if (files.has(parent)) throw new Error('colliding committed path')
      directories.add(parent)
    }
    files.add(path)
  }
  return inventory
}

/** Stream only requested blobs through one owned Git process, bounded to one blob in memory. */
export async function readCommittedBlobs(root, requested, consume) {
  const ids = [...new Set(requested)]
  if (!ids.length) return
  if (ids.some(id => !/^[a-f0-9]{40}$/.test(id))) throw new Error('invalid committed blob identity')
  const child = spawn('git', ['-C', root, 'cat-file', '--batch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderrBytes = 0
  child.stderr.on('data', chunk => { stderrBytes += chunk.length })
  const exited = new Promise(resolve => {
    child.once('error', () => resolve({ failed: true }))
    child.once('close', (code, signal) => resolve({ failed: code !== 0 || Boolean(signal) }))
  })
  child.stdin.on('error', () => {})
  child.stdin.end(ids.join('\n') + '\n')
  let header = Buffer.alloc(0), parts = [], remaining = null, size = 0, index = 0
  try {
    for await (const chunk of child.stdout) {
      let offset = 0
      while (offset < chunk.length) {
        if (remaining === null) {
          const end = chunk.indexOf(10, offset)
          const stop = end < 0 ? chunk.length : end
          header = Buffer.concat([header, chunk.subarray(offset, stop)])
          if (header.length > 160) throw new Error('invalid committed blob header')
          offset = end < 0 ? stop : end + 1
          if (end < 0) continue
          const match = header.toString('ascii').match(/^([a-f0-9]{40}) blob (\d+)$/)
          if (!match || match[1] !== ids[index]) throw new Error('committed blob unavailable')
          size = Number(match[2])
          if (!Number.isSafeInteger(size) || size > 20 * 1024 * 1024) throw new Error('committed blob size limit exceeded')
          remaining = size
        } else if (remaining > 0) {
          const take = Math.min(remaining, chunk.length - offset)
          parts.push(chunk.subarray(offset, offset + take))
          remaining -= take
          offset += take
        } else {
          if (chunk[offset++] !== 10) throw new Error('invalid committed blob boundary')
          await consume(ids[index++], Buffer.concat(parts, size))
          header = Buffer.alloc(0); parts = []; remaining = null
        }
      }
    }
    const result = await exited
    if (result.failed || index !== ids.length || header.length || remaining !== null || stderrBytes) throw new Error('committed blob read incomplete')
  } catch (error) {
    child.kill()
    await exited
    throw error
  }
}
