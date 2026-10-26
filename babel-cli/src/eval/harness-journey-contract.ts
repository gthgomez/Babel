/** Outcome evaluation is separate from candidate lifecycle and success prose. */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

export const JourneySpecSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Expected portable single-component journey id').refine(id => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), 'Expected portable journey id'),
  family: z.enum(['conversation', 'research', 'inspection', 'code', 'artifact', 'connected_action', 'mixed_long']),
  prompt: z.string().min(1), fixtureId: z.string().min(1), grantsProfile: z.string().min(1),
  faultIds: z.array(z.string().min(1)), oracleId: z.string().min(1),
  limits: z.object({ wallMs: z.number().int().positive(), maxTurns: z.number().int().positive(), maxCostUsd: z.number().finite().nonnegative() }).strict(),
}).strict()

export type JourneySpec = z.infer<typeof JourneySpecSchema>
export type Fulfillment = 'complete' | 'partial' | 'incomplete' | 'unsupported'
export type OracleVerdict = 'pass' | 'fail' | 'unavailable'
export interface JourneyUsage {
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  complete: boolean
}
export interface JourneyObservation {
  routeReceipt: { provider: string; model: string; evidenceRef: string } | null
  interventions: readonly string[]
  usage: JourneyUsage | null
  evidenceRefs: readonly string[]
}
const ObservationSchema = z.object({
  routeReceipt: z.object({ provider: z.string().min(1), model: z.string().min(1), evidenceRef: z.string().min(1) }).strict().nullable(),
  interventions: z.array(z.string()), evidenceRefs: z.array(z.string()),
  usage: z.object({ costUsd: z.number().finite().nonnegative().nullable(), inputTokens: z.number().finite().nonnegative().nullable(), outputTokens: z.number().finite().nonnegative().nullable(), complete: z.boolean() }).strict().nullable(),
}).strict()
export interface JourneyResult {
  id: string
  candidateId: string
  evaluatorDigest: string
  routeReceipt: JourneyObservation['routeReceipt']
  fulfillment: Fulfillment
  lifecycle: 'completed' | 'failed'
  oracleVerdict: OracleVerdict
  interventions: readonly string[]
  usage: JourneyUsage
  timing: { startedAt: string; wallMs: number }
  evidenceRefs: readonly string[]
  diagnostics: readonly string[]
}
export type JourneyInput = Readonly<Omit<JourneySpec, 'oracleId'>>

/** Trusted host adapter, not a model-supplied object. observe reads host receipts. */
export interface JourneyCandidate {
  readonly id: string
  execute(input: JourneyInput): Promise<unknown>
  observe(): JourneyObservation | Promise<JourneyObservation>
}
const GradeSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unavailable']),
  fulfillment: z.enum(['complete', 'partial', 'incomplete', 'unsupported']),
  evidenceRefs: z.array(z.string()),
}).strict()
export interface JourneyGrade {
  verdict: string
  fulfillment: string
  evidenceRefs: readonly string[]
}
export interface FrozenEvaluator {
  readonly digest: string
  /** Checks the full planned cell; callers cannot swap expected values or oracle. */
  bind(spec: JourneySpec): { evaluate(): Promise<z.infer<typeof GradeSchema>> }
  intact(): Promise<boolean>
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(spec: JourneySpec): string {
  return JSON.stringify(JourneySpecSchema.parse(spec))
}

async function fileDigest(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Evaluator input must be a regular file')
  return hash(await readFile(path))
}

/**
 * Seal trusted evaluator code/data and planned cells before candidate dispatch.
 * This detects tampering; the host must separately keep these paths outside all
 * candidate grants. An in-process callback is not a filesystem sandbox. Campaign
 * drivers must pin the evaluator revision and include its transitive code/data.
 */
export async function freezeEvaluator(input: {
  revision: string
  specs: readonly JourneySpec[]
  protectedFiles: readonly string[]
  evaluate(spec: Readonly<JourneySpec>): Promise<JourneyGrade>
}): Promise<FrozenEvaluator> {
  if (!input.revision.trim()) throw new Error('Evaluator revision required')
  const specs = new Map<string, string>()
  for (const spec of input.specs) {
    if (specs.has(spec.id)) throw new Error('Duplicate journey id')
    specs.set(spec.id, canonical(spec))
  }
  const files: [string, string][] = []
  for (const path of [...new Set(input.protectedFiles.map(path => resolve(path)))].sort()) {
    files.push([path, await fileDigest(path)])
  }
  const evaluate = input.evaluate
  return Object.freeze({
    digest: hash(JSON.stringify({ revision: input.revision, specs: [...specs], files })),
    bind(spec: JourneySpec) {
      const planned = specs.get(spec.id)
      if (planned === undefined || planned !== canonical(spec)) throw new Error('Cell differs from frozen journey')
      return {
        async evaluate() {
          // A fresh parsed copy prevents a grader or adapter mutating later cells.
          return GradeSchema.parse(await evaluate(JourneySpecSchema.parse(JSON.parse(planned))))
        },
      }
    },
    async intact() {
      for (const [path, expected] of files) {
        try { if (await fileDigest(path) !== expected) return false } catch { return false }
      }
      return true
    },
  })
}

const unknownUsage = (): JourneyUsage => ({ costUsd: null, inputTokens: null, outputTokens: null, complete: false })

function observedUsage(usage: JourneyUsage | null): JourneyUsage {
  if (!usage) return unknownUsage()
  const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const costUsd = nonnegative(usage.costUsd) ? usage.costUsd : null
  const inputTokens = nonnegative(usage.inputTokens) ? usage.inputTokens : null
  const outputTokens = nonnegative(usage.outputTokens) ? usage.outputTokens : null
  return { costUsd, inputTokens, outputTokens, complete: usage.complete === true && costUsd !== null && inputTokens !== null && outputTokens !== null }
}

/** Run one real adapter entry point; ignore its model/backend success payload. */
export async function runJourney(spec: JourneySpec, candidate: JourneyCandidate, evaluator: FrozenEvaluator): Promise<JourneyResult> {
  const bound = evaluator.bind(spec)
  const planned = JourneySpecSchema.parse(spec)
  const candidateId = candidate.id
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const diagnostics: string[] = []
  let lifecycle: JourneyResult['lifecycle'] = 'completed'
  let grade: z.infer<typeof GradeSchema> = { verdict: 'unavailable', fulfillment: 'incomplete', evidenceRefs: [] }
  let observation: JourneyObservation = { routeReceipt: null, usage: null, interventions: [], evidenceRefs: [] }
  if (!(await evaluator.intact())) {
    lifecycle = 'failed'
    diagnostics.push('evaluator_integrity_changed')
  } else {
    const { oracleId: _oracleId, ...input } = planned
    try { await candidate.execute(structuredClone(input)) } catch {
      lifecycle = 'failed'
      diagnostics.push('candidate_execution_failed')
    }
    // Observation and grading errors do not erase an already attempted cell.
    try { observation = ObservationSchema.parse(await candidate.observe()) } catch { diagnostics.push('host_observation_unavailable') }
    if (!(await evaluator.intact())) diagnostics.push('evaluator_integrity_changed')
    else {
      try { grade = await bound.evaluate() } catch { diagnostics.push('oracle_unavailable') }
      if (!(await evaluator.intact())) {
        diagnostics.push('evaluator_integrity_changed')
        grade = { verdict: 'unavailable', fulfillment: 'incomplete', evidenceRefs: [] }
      }
    }
  }
  // A failed/missing oracle or interrupted lifecycle cannot be complete.
  let fulfillment = grade.fulfillment
  if (fulfillment === 'complete' && grade.verdict !== 'pass') fulfillment = 'incomplete'
  if (fulfillment === 'complete' && lifecycle !== 'completed') fulfillment = 'partial'
  return {
    id: planned.id, candidateId, evaluatorDigest: evaluator.digest,
    routeReceipt: observation.routeReceipt, fulfillment, lifecycle, oracleVerdict: grade.verdict,
    interventions: [...observation.interventions], usage: observedUsage(observation.usage),
    timing: { startedAt, wallMs: performance.now() - start },
    evidenceRefs: [...observation.evidenceRefs, ...grade.evidenceRefs], diagnostics,
  }
}

/** Persist every attempted cell before proceeding; never filter failed cells. */
export async function runJourneys(
  specs: readonly JourneySpec[], candidate: JourneyCandidate, evaluator: FrozenEvaluator,
  retain: (result: JourneyResult) => Promise<void>,
): Promise<JourneyResult[]> {
  // Validate the whole schedule before starting any candidate effects.
  const schedule = specs.map(spec => JourneySpecSchema.parse(spec))
  if (new Set(schedule.map(spec => spec.id)).size !== schedule.length) throw new Error('Duplicate journey id')
  for (const spec of schedule) evaluator.bind(spec)
  const results: JourneyResult[] = []
  for (const spec of schedule) {
    const result = await runJourney(spec, candidate, evaluator)
    await retain(result)
    results.push(result)
  }
  return results
}
