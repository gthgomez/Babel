import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const MAX_RUN_OUTPUT_BYTES = 8 * 1024 * 1024
export const MAX_ARTIFACT_LINES = 200
export const MAX_ARTIFACT_CHARS = 16000

export const ReadArtifactActionSchema = z.object({
  type: z.literal('read_artifact'), artifact_id: z.string().uuid(),
  start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(),
  start_column: z.number().int().positive().optional(),
  query: z.string().min(1).max(256).optional(),
})

export interface RunOutputOwner {
  sessionId: string
  taskOwnerId: string
  acceptedTaskId: string
}

const OwnerSchema = z.object({ sessionId: z.string().min(1), taskOwnerId: z.string().min(1), acceptedTaskId: z.string().min(1) })
const ArtifactSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), owner: OwnerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(MAX_RUN_OUTPUT_BYTES),
  tool: z.string().min(1).max(100), callId: z.string().max(256),
  operations: z.tuple([z.literal('range'), z.literal('search')]),
})
export type RunOutputArtifact = z.infer<typeof ArtifactSchema>
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function artifactRoot(runDir: string, create = false): string {
  // The host supplies the durable session directory; callers never supply a
  // content path. Reject redirection of the session or artifact directory.
  if (lstatSync(runDir).isSymbolicLink()) throw new Error('ARTIFACT_DENIED')
  const root = join(realpathSync(runDir), 'tool-output-artifacts')
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
    || realpathSync(root) !== resolve(root)) throw new Error('ARTIFACT_DENIED')
  return root
}

function readOwnedFile(path: string, maxBytes: number): Buffer {
  if (realpathSync(path) !== resolve(path)) throw new Error('ARTIFACT_DENIED')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('ARTIFACT_DENIED')
  const fd = openSync(path, 'r')
  try {
    const opened = fstatSync(fd)
    const named = lstatSync(path)
    if (!opened.isFile() || opened.size > maxBytes || opened.ino !== before.ino || opened.dev !== before.dev
      || named.isSymbolicLink() || named.ino !== opened.ino || named.dev !== opened.dev) throw new Error('ARTIFACT_DENIED')
    if (realpathSync(path) !== resolve(path)) throw new Error('ARTIFACT_DENIED')
    const bytes = Buffer.alloc(opened.size + 1)
    let count = 0
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count)
      if (read === 0) break
      count += read
    }
    if (count > maxBytes || count !== opened.size) throw new Error('ARTIFACT_CONTENT_IDENTITY_CHANGED')
    return bytes.subarray(0, count)
  } finally { closeSync(fd) }
}

function writeImmutable(path: string, bytes: string): void {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}

/** Enroll only compiler-produced bytes, with an immutable revision and durable owner. */
export function registerRunOutput(input: {
  runDir: string; owner: RunOutputOwner; content: string; tool: string; callId: string
}): RunOutputArtifact {
  const owner = OwnerSchema.parse(input.owner)
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > MAX_RUN_OUTPUT_BYTES) throw new Error('ARTIFACT_RESOURCE_BOUND_EXCEEDED')
  const root = artifactRoot(input.runDir, true)
  const artifact = ArtifactSchema.parse({ schemaVersion: 1, id: randomUUID(), owner,
    sha256: hash(input.content), bytes, tool: input.tool, callId: input.callId, operations: ['range', 'search'] })
  writeImmutable(join(root, `${artifact.id}.log`), input.content)
  // Publish only after content is flushed. An interrupted enrollment exposes no
  // handle; orphan content is never enrolled merely because its name is known.
  writeImmutable(join(root, `${artifact.id}.json`), JSON.stringify(artifact))
  return artifact
}

/** Bounded retrieval of a registered artifact in the current durable task only. */
export function readRunOutput(input: {
  runDir: string; owner: RunOutputOwner; artifactId: string
  startLine?: number; endLine?: number; startColumn?: number; query?: string; signal?: AbortSignal
}): string {
  const checkCancelled = (): void => { if (input.signal?.aborted) throw new Error('ARTIFACT_CANCELLED') }
  checkCancelled()
  if (!z.string().uuid().safeParse(input.artifactId).success) throw new Error('ARTIFACT_DENIED')
  const start = input.startLine ?? 1
  const end = input.endLine ?? Number.MAX_SAFE_INTEGER
  const column = input.startColumn ?? 1
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start
    || !Number.isSafeInteger(column) || column < 1
    || (input.query !== undefined && (input.query.length === 0 || input.query.length > 256))) throw new Error('ARTIFACT_INVALID_RANGE_OR_SEARCH')
  const root = artifactRoot(input.runDir)
  let artifact: RunOutputArtifact
  try {
    artifact = ArtifactSchema.parse(JSON.parse(readOwnedFile(join(root, `${input.artifactId}.json`), 4096).toString('utf8')))
  } catch { throw new Error('ARTIFACT_DENIED') }
  if (artifact.id !== input.artifactId || !OwnerSchema.safeParse(input.owner).success
    || artifact.owner.sessionId !== input.owner.sessionId || artifact.owner.taskOwnerId !== input.owner.taskOwnerId
    || artifact.owner.acceptedTaskId !== input.owner.acceptedTaskId) throw new Error('ARTIFACT_DENIED')
  const bytes = readOwnedFile(join(root, `${artifact.id}.log`), MAX_RUN_OUTPUT_BYTES)
  if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error('ARTIFACT_CONTENT_IDENTITY_CHANGED')
  checkCancelled()
  const text = bytes.toString('utf8')
  const selected: string[] = []
  let line = 0
  let offset = 0
  let chars = 0
  let truncated = false
  let continuation = ''
  do {
    checkCancelled()
    const next = text.indexOf('\n', offset)
    const value = text.slice(offset, next < 0 ? text.length : next)
    line += 1
    const lineColumn = line === start ? column : 1
    const match = input.query === undefined ? lineColumn - 1 : value.indexOf(input.query, lineColumn - 1)
    if (line >= start && line <= end && match >= 0 && match <= value.length) {
      if (selected.length >= MAX_ARTIFACT_LINES || chars >= MAX_ARTIFACT_CHARS) {
        truncated = true; continuation = `start_line: ${line}`; break
      }
      const from = input.query === undefined ? match : Math.max(lineColumn - 1, match - 256)
      const prefix = `${line}: ${from > 0 ? `[column ${from + 1}] ` : ''}`
      const remaining = MAX_ARTIFACT_CHARS - chars
      if (remaining <= prefix.length) {
        truncated = true; continuation = `start_line: ${line}, start_column: ${from + 1}`; break
      }
      const fragment = value.slice(from, from + Math.max(0, remaining - prefix.length))
      selected.push(prefix + fragment)
      chars += prefix.length + fragment.length + 1
      if (from + fragment.length < value.length) {
        truncated = true; continuation = `start_line: ${line}, start_column: ${from + fragment.length + 1}`; break
      }
    }
    if (next < 0) break
    offset = next + 1
  } while (offset <= text.length)
  return [`artifact: ${artifact.id}`, `sha256: ${artifact.sha256}`, `source: ${artifact.tool} call=${artifact.callId}`,
    `session: ${artifact.owner.sessionId} task: ${artifact.owner.acceptedTaskId}`,
    ...selected, ...(selected.length ? [] : ['[EMPTY RANGE OR NO MATCH]']),
    ...(truncated ? [`[TRUNCATED: continue with ${continuation}]`] : [])].join('\n')
}
