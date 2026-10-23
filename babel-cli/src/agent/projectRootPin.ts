/** Compatibility-only ambient pin; explicit ToolContext / ALS still own routing. */
const pins: Array<{ root: string }> = []
let priorRoot: string | undefined

/** Release is idempotent and may occur in any order across overlapping actions. */
export function pinProjectRootEnv(projectRoot: string): () => void {
  if (pins.length === 0) priorRoot = process.env['BABEL_PROJECT_ROOT']
  const pin = { root: projectRoot }
  pins.push(pin)
  process.env['BABEL_PROJECT_ROOT'] = projectRoot
  return () => {
    const index = pins.indexOf(pin)
    if (index < 0) return
    pins.splice(index, 1)
    const root = pins.at(-1)?.root ?? priorRoot
    if (root === undefined) delete process.env['BABEL_PROJECT_ROOT']
    else process.env['BABEL_PROJECT_ROOT'] = root
    if (pins.length === 0) priorRoot = undefined
  }
}
