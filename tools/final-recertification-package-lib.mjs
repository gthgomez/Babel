import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const PACKAGE_SCHEMA = 'babel-final-recertification-v1'
export const MANIFEST_FILE = 'MANIFEST.json'
const HASH = /^[a-f0-9]{64}$/i
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

const EVIDENCE_TYPES = new Set([
  'changed-file-list',
  'final-report',
  'git-diff',
  'before-source',
  'after-source',
  'source-snapshot',
])

function fail(message) {
  throw new Error(message)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedPackagePath(value) {
  if (typeof value !== 'string' || value.length === 0) fail('package path is empty')
  const path = value.replaceAll('\\', '/')
  if (
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').some((part) => part === '..')
  ) {
    fail(`unsafe package path: ${value}`)
  }
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) fail(`unsafe package path: ${value}`)
  return parts.join('/')
}

function walkFiles(root) {
  const absoluteRoot = resolve(root)
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    fail(`package root is not a directory: ${absoluteRoot}`)
  }
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail(`symbolic links are not allowed in packages: ${path}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(absoluteRoot)
  return files.sort()
}

function readText(buffer) {
  return buffer.toString('utf8').replaceAll('\r\n', '\n')
}

function looksLikeHelpOrError(text) {
  const trimmed = text.trim()
  if (!trimmed) return true
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  if (/^usage:\s*(?:git|pwsh|powershell|npm|node)\b/i.test(first)) return true
  if (/^(?:fatal error|error:|traceback \(|command not found|.* is not recognized as .*command)/i.test(first)) {
    return lines.length <= 24
  }
  if (/^git\s+\[[^\n]+\]/i.test(first) && lines.length <= 80) return true
  return false
}

function hasForbiddenEvidenceSignature(text) {
  return /usage:\s*git\b|command not found|is not recognized as the name of a cmdlet|traceback \(|fatal:\s+not a git repository/i.test(text)
}

export function semanticTypeForPath(path) {
  const normalized = normalizedPackagePath(path)
  const lower = normalized.toLowerCase()
  const file = basename(lower)
  const extension = extname(lower)
  if (file === 'final_report.md') return 'final-report'
  if (lower.includes('/changed-files') || file === 'changed-files.txt' || file === 'files-changed.txt') {
    return 'changed-file-list'
  }
  if (extension === '.diff' || extension === '.patch' || lower.endsWith('/final-diff.txt')) {
    return 'git-diff'
  }
  if (/(^|[./_-])before([./_-]|$)/.test(file) || lower.includes('/before/')) return 'before-source'
  if (/(^|[./_-])after([./_-]|$)/.test(file) || lower.includes('/after/')) return 'after-source'
  if (['.ts', '.tsx', '.mjs', '.cjs', '.js', '.ps1', '.psm1', '.yml', '.yaml', '.sh'].includes(extension)) {
    return 'source-snapshot'
  }
  if (
    file.includes('manifest') ||
    file.includes('status') ||
    file.includes('receipt') ||
    file.includes('summary') ||
    file.includes('ledger') ||
    file.includes('inventory') ||
    file.includes('branch') ||
    file.includes('worktree') ||
    file.includes('disposition') ||
    file.includes('classification') ||
    file.includes('metrics') ||
    file.endsWith('.json')
  ) return 'machine-evidence'
  return 'text-evidence'
}

function plausibleSource(path, text) {
  const extension = extname(path.toLowerCase())
  if (extension === '.json') {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }
  if (['.ts', '.tsx', '.mjs', '.cjs', '.js'].includes(extension)) {
    return /\b(?:import|export|const|let|function|class|interface|type|async)\b|=>/.test(text)
  }
  if (['.ps1', '.psm1'].includes(extension)) return /param\s*\(|\$[A-Za-z_]|\b(?:function|Write-|Get-|Set-|Test-|Invoke-)/.test(text)
  if (['.yml', '.yaml'].includes(extension)) return /(^|\n)\s*[A-Za-z0-9_.-]+\s*:/.test(text)
  if (extension === '.sh') return /(?:^#!\/|\b(?:case|if|then|fi|set)\b)/.test(text)
  return text.trim().length > 0
}

function validateChangedFileList(path, text, errors) {
  if (looksLikeHelpOrError(text) || hasForbiddenEvidenceSignature(text)) {
    errors.push(`${path}: changed-file list contains help/error output`)
    return
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) {
    errors.push(`${path}: changed-file list is empty`)
    return
  }
  for (const line of lines) {
    const record = line.replace(/^(?:[MADRCU?!]{1,2}|\*{1,2})\s+/, '').trim()
    if (
      record.length === 0 ||
      /^diff --git\b/i.test(record) ||
      /^(?:error|fatal|traceback)\b/i.test(record) ||
      !/^[A-Za-z0-9_.~@+\-\\/()[\]{} ,#=]+$/.test(record)
    ) {
      errors.push(`${path}: non-path record in changed-file list`)
      return
    }
  }
}

function validateSemanticEntry(path, type, buffer, errors) {
  const text = readText(buffer)
  if (buffer.byteLength === 0) {
    errors.push(`${path}: evidence file is empty`)
    return
  }
  if (hasForbiddenEvidenceSignature(text) && type !== 'source-snapshot') {
    errors.push(`${path}: evidence contains a forbidden help/error signature`)
  }
  if (type === 'git-diff') {
    if (looksLikeHelpOrError(text) || !(/(^|\n)diff --git\b/.test(text) || /(^|\n)---\s+[^\n]+\n\+\+\+\s+[^\n]+/.test(text))) {
      errors.push(`${path}: advertised diff is not a nonempty Git diff`)
    }
  } else if (type === 'source-snapshot') {
    if (looksLikeHelpOrError(text) || !plausibleSource(path, text)) {
      errors.push(`${path}: advertised source snapshot is empty, help output, or implausible source`)
    }
  } else if (type === 'changed-file-list') {
    validateChangedFileList(path, text, errors)
  } else if (type === 'final-report') {
    for (const heading of [
      'FINAL_VERDICT',
      'FINAL_REPOSITORY_STATE',
      'PR_DISPOSITION',
      'REQUIRED_FIXES',
      'CERTIFICATION',
      'CLEANUP',
      'LIVE_DEEPSWE',
      'REMAINING_RISKS',
      'REVIEW_PACKAGE',
    ]) {
      if (!new RegExp(`^##\\s+${heading}\\s*$`, 'mi').test(text)) {
        errors.push(`${path}: final report is missing ${heading}`)
      }
    }
  }
}

function readIntentionalDuplicates(root) {
  const path = join(root, 'intentional-duplicates.json')
  if (!existsSync(path)) return []
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || !Array.isArray(value.groups)) return []
    return value.groups
      .filter((group) => group && Array.isArray(group.paths) && typeof group.reason === 'string' && group.reason.trim().length >= 12)
      .map((group) => new Set(group.paths.map(normalizedPackagePath)))
  } catch {
    return []
  }
}

function duplicateIsDeclared(pathA, pathB, declarations) {
  return declarations.some((group) => group.has(pathA) && group.has(pathB))
}

function validateManifestValue(root, manifest, errors) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('MANIFEST.json is not an object')
    return []
  }
  if (manifest.schemaVersion !== 1 || manifest.packageSchema !== PACKAGE_SCHEMA) {
    errors.push('MANIFEST.json has an unsupported schema')
  }
  if (typeof manifest.createdAt !== 'string' || manifest.createdAt.length === 0) errors.push('MANIFEST.json createdAt is missing')
  if (!Array.isArray(manifest.entries)) {
    errors.push('MANIFEST.json entries is not an array')
    return []
  }
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object') {
      errors.push('MANIFEST.json contains a non-object entry')
      continue
    }
    let path
    try {
      path = normalizedPackagePath(entry.path)
    } catch {
      errors.push('MANIFEST.json contains an unsafe path')
      continue
    }
    if (entry.path !== path) errors.push(`MANIFEST.json path is not canonical: ${entry.path}`)
    if (path === MANIFEST_FILE || seen.has(path)) errors.push(`MANIFEST.json repeats or self-references ${path}`)
    seen.add(path)
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_ENTRY_BYTES) errors.push(`${path}: invalid byte count`)
    if (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) errors.push(`${path}: invalid SHA-256`)
    if (typeof entry.semantic_type !== 'string' || entry.semantic_type.length === 0) errors.push(`${path}: semantic_type is missing`)
    if (!(entry.source_commit === null || typeof entry.source_commit === 'string')) errors.push(`${path}: source_commit is invalid`)
  }
  return [...seen]
}

export function validateDirectory(root) {
  const absoluteRoot = resolve(root)
  const errors = []
  const actual = walkFiles(absoluteRoot)
    .map((path) => normalizedPackagePath(relative(absoluteRoot, path)))
    .sort()
  const manifestPath = join(absoluteRoot, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    errors.push('MANIFEST.json is missing')
    return { status: 'FAIL', root: absoluteRoot, manifest_file_count: 0, errors }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    errors.push('MANIFEST.json is not valid JSON')
    return { status: 'FAIL', root: absoluteRoot, manifest_file_count: 0, errors }
  }
  const manifestPaths = validateManifestValue(absoluteRoot, manifest, errors)
  const payloadPaths = actual.filter((path) => path !== MANIFEST_FILE)
  const manifestSet = new Set(manifestPaths)
  const actualSet = new Set(payloadPaths)
  for (const path of manifestPaths) if (!actualSet.has(path)) errors.push(`${path}: manifest entry is missing from package`)
  for (const path of payloadPaths) if (!manifestSet.has(path)) errors.push(`${path}: package file is missing from manifest`)

  const entryByPath = new Map()
  for (const entry of manifest.entries ?? []) {
    try {
      entryByPath.set(normalizedPackagePath(entry.path), entry)
    } catch {
      // validateManifestValue already reports malformed paths.
    }
  }
  const hashGroups = new Map()
  for (const path of payloadPaths) {
    const entry = entryByPath.get(path)
    if (!entry) continue
    const buffer = readFileSync(join(absoluteRoot, path))
    if (buffer.byteLength > MAX_ENTRY_BYTES) errors.push(`${path}: entry exceeds size limit`)
    if (entry.bytes !== buffer.byteLength) errors.push(`${path}: byte count does not match manifest`)
    if (typeof entry.sha256 === 'string' && HASH.test(entry.sha256) && entry.sha256.toLowerCase() !== sha256(buffer)) errors.push(`${path}: SHA-256 does not match manifest`)
    validateSemanticEntry(path, entry.semantic_type, buffer, errors)
    const hash = sha256(buffer)
    const group = hashGroups.get(hash) ?? []
    group.push({ path, type: entry.semantic_type })
    hashGroups.set(hash, group)
  }

  const duplicateDeclarations = readIntentionalDuplicates(absoluteRoot)
  const duplicateErrors = []
  for (const group of hashGroups.values()) {
    if (group.length < 2 || !group.some((entry) => EVIDENCE_TYPES.has(entry.type))) continue
    for (let index = 0; index < group.length; index += 1) {
      for (let other = index + 1; other < group.length; other += 1) {
        const left = group[index]
        const right = group[other]
        if (!left || !right || duplicateIsDeclared(left.path, right.path, duplicateDeclarations)) continue
        duplicateErrors.push(`${left.path} and ${right.path} are byte-identical evidence without an intentional duplicate declaration`)
      }
    }
  }
  errors.push(...duplicateErrors)

  for (const directory of ['repository', 'verification', 'trust-gate', 'cleanup', 'live-eval']) {
    if (!payloadPaths.some((path) => path.startsWith(`${directory}/`))) errors.push(`required package directory is missing: ${directory}`)
  }
  const secretFindings = []
  const secretPattern = /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----|sk-or-v1-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|(?:authorization|x-api-key)\s*[:=]\s*bearer\s+(?!\[redacted\])[A-Za-z0-9._-]{16,}/i
  for (const path of payloadPaths) {
    const text = readText(readFileSync(join(absoluteRoot, path)))
    if (secretPattern.test(text)) secretFindings.push(path)
  }
  if (secretFindings.length > 0) errors.push(`secret scan failed for ${secretFindings.length} package file(s)`)

  const totalBytes = payloadPaths.reduce((total, path) => total + statSync(join(absoluteRoot, path)).size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) errors.push('package exceeds total size limit')
  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    root: absoluteRoot,
    manifest_file_count: manifestPaths.length,
    total_bytes: totalBytes,
    errors,
    semantic_validation: errors.some((error) => /advertised|final report|changed-file|help\/error|evidence file|package directory/.test(error)) ? 'FAIL' : 'PASS',
    duplicate_validation: duplicateErrors.length === 0 ? 'PASS' : 'FAIL',
    secret_scan: secretFindings.length === 0 ? 'PASS' : 'FAIL',
    extraction_reverification: 'PASS',
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function dosDate() {
  return { time: 0, date: 0x21 }
}

export function zipDirectory(root, output) {
  const absoluteRoot = resolve(root)
  const outputPath = resolve(output)
  mkdirSync(dirname(outputPath), { recursive: true })
  const chunks = []
  const central = []
  let offset = 0
  for (const path of walkFiles(absoluteRoot).map((value) => normalizedPackagePath(relative(absoluteRoot, value))).sort()) {
    const name = Buffer.from(path, 'utf8')
    const source = readFileSync(join(absoluteRoot, path))
    const compressed = deflateRawSync(source)
    const method = compressed.length + 10 < source.length ? 8 : 0
    const payload = method === 8 ? compressed : source
    const checksum = crc32(source)
    const date = dosDate()
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(date.time, 10)
    local.writeUInt16LE(date.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(source.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    chunks.push(local, payload)
    const directory = Buffer.alloc(46 + name.length)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x800, 8)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt16LE(date.time, 12)
    directory.writeUInt16LE(date.date, 14)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(source.length, 24)
    directory.writeUInt16LE(name.length, 28)
    name.copy(directory, 46)
    directory.writeUInt32LE(offset, 42)
    central.push(directory)
    offset += local.length + payload.length
  }
  const centralOffset = offset
  const centralData = Buffer.concat(central)
  chunks.push(centralData)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralData.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  chunks.push(end)
  writeFileSync(outputPath, Buffer.concat(chunks))
  return outputPath
}

function readZipEntries(zipPath) {
  const archive = readFileSync(zipPath)
  const searchStart = Math.max(0, archive.length - 0xffff - 22)
  let endOffset = -1
  for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) fail('ZIP end-of-central-directory record is missing')
  const count = archive.readUInt16LE(endOffset + 10)
  const centralSize = archive.readUInt32LE(endOffset + 12)
  const centralOffset = archive.readUInt32LE(endOffset + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are not supported')
  const entries = new Map()
  let cursor = centralOffset
  let totalBytes = 0
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) fail('ZIP central directory is malformed')
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const name = normalizedPackagePath(rawName)
    if (entries.has(name)) fail(`ZIP contains duplicate entry: ${name}`)
    if ((flags & 1) !== 0 || (flags & 8) !== 0) fail(`ZIP entry uses unsupported flags: ${name}`)
    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_TOTAL_BYTES) fail(`ZIP entry exceeds package limits: ${name}`)
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) fail(`ZIP local header is malformed: ${name}`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(start, start + compressedSize)
    if (compressed.length !== compressedSize) fail(`ZIP entry is truncated: ${name}`)
    let data
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
    else fail(`ZIP entry uses unsupported compression: ${name}`)
    if (data.length !== uncompressedSize) fail(`ZIP entry size mismatch: ${name}`)
    entries.set(name, data)
    totalBytes += data.length
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor !== centralOffset + centralSize) fail('ZIP central directory size mismatch')
  return entries
}

export function validatePackageInput(input) {
  const absoluteInput = resolve(input)
  if (!existsSync(absoluteInput)) return { status: 'FAIL', input: absoluteInput, errors: ['input does not exist'] }
  if (statSync(absoluteInput).isDirectory()) return validateDirectory(absoluteInput)
  if (!statSync(absoluteInput).isFile()) return { status: 'FAIL', input: absoluteInput, errors: ['input is not a file or directory'] }
  let entries
  try {
    entries = readZipEntries(absoluteInput)
  } catch (error) {
    return { status: 'FAIL', input: absoluteInput, errors: [error instanceof Error ? error.message : String(error)], extraction_reverification: 'FAIL' }
  }
  const extractionRoot = mkdtempSync(join(tmpdir(), 'babel-final-package-'))
  try {
    for (const [path, data] of entries) {
      const destination = join(extractionRoot, path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, data)
    }
    const result = validateDirectory(extractionRoot)
    return { ...result, input: absoluteInput, extraction_reverification: result.status === 'PASS' ? 'PASS' : 'FAIL' }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true })
  }
}

export function createManifest(root, metadata = {}) {
  const absoluteRoot = resolve(root)
  const entries = walkFiles(absoluteRoot)
    .map((path) => normalizedPackagePath(relative(absoluteRoot, path)))
    .filter((path) => path !== MANIFEST_FILE)
    .sort()
    .map((path) => {
      const data = readFileSync(join(absoluteRoot, path))
      return {
        path,
        bytes: data.byteLength,
        sha256: sha256(data),
        semantic_type: semanticTypeForPath(path),
        source_commit: metadata.sourceCommitByPath?.[path] ?? metadata.sourceCommit ?? null,
      }
    })
  return {
    schemaVersion: 1,
    packageSchema: PACKAGE_SCHEMA,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
    finalMainSha: metadata.finalMainSha ?? null,
    entries,
  }
}
