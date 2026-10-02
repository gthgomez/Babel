/** Task-text intent policy, separate from submission and completion authority. */
import type { TaskIntent } from './chatEngineContracts.js'

const PUNCTUATION_ONLY_TURN_RE = /^[\s\p{P}\p{S}\p{C}]*$/u

// ─── Conversational-turn detection ────────────────────────────────────────
// Pure greetings / acknowledgements / punctuation-only turns ('?', 'hello',
// 'thanks') carry no task content. They must not take the execute path:
// execute-intent classification makes the zero-write completion refusal
// re-query trivial turns until the turn budget is exhausted. Whole-input
// match keeps action-bearing requests ('hi — fix the bug') on execute via
// the verb checks in classifyChatTaskIntent.
const CONVERSATIONAL_TURN_RE =
  /^(?:(?:hi+|hello+|hey+|yo|sup|howdy|greetings|good\s*(?:morning|afternoon|evening|day)|hi\s+there|hello\s+there|thanks|thank\s*you|thankyou|thx|ty|ok(?:ay)?|cool|nice|great|awesome|perfect|got\s*it|sounds\s+good|bye|goodbye|see\s*ya)(?:[!,.?;:\s]+|$))+$/i

function isConversationalTurnText(task: string): boolean {
  const t = task.trim()
  if (!t || t.length > 32) return false
  return PUNCTUATION_ONLY_TURN_RE.test(t) || CONVERSATIONAL_TURN_RE.test(t)
}

/** Classify task text without granting mutation authority from evidence content. */
export function classifyChatTaskIntent(task: string): TaskIntent {
  // Conversational / non-actionable turns ('?', 'hello') are never execute
  // tasks — there is nothing to mutate, and execute classification makes
  // the implementor zero-write refusal loop re-query them until maxTurns.
  if (isConversationalTurnText(task)) return 'explain'

  // Explicit read-only / no-edit directives → explain.
  // MUST be checked before fenced code and execute verb patterns: evidence
  // content (a pasted snippet, diff, or a path named "repair"/"write") is
  // never mutation authority, and "fix this without editing files" routes to
  // explain rather than execute.
  if (
    /\b(without\s+(editing|modifying|changing|writing|touching)|read[- ]only|do\s+not\s+(edit|modify|change|write|delete|remove))\b/i.test(
      task,
    )
  )
    return 'explain'

  // Explicit markdown fenced code blocks or diff/patch snippets → execute
  if (/```(?:diff|patch|javascript|typescript|python|go|rust)\b/.test(task))
    return 'execute'

  // Review/audit prompts are read-only even when their evidence contains
  // mutation-shaped words such as "repair" in a path or diff description.
  // A paired edit directive remains executable (for example, "review and
  // fix it"). Keeping this before the generic mutation verbs prevents the
  // trusted reviewer from entering the coding zero-write recovery loop.
  if (
    /\b(review|audit|analyze|diagnose|inspect|investigate|research|check|find|locate|search|look\s+for|compare|contrast|evaluate|assess|report\s+(tradeoffs|findings|back|on))\b(?!.*\b(and|then)\s+(fix|repair|implement|resolve|patch|refactor|migrate|upgrade|update|create|write|edit|modify|change|remove|delete|revert|rewrite|replace)\b)(?!.*\bfix\s+it\b)/i.test(
      task,
    )
  )
    return 'explain'

  // Fix/implement/create verbs → execute
  if (
    /\b(fix|repair|implement|resolve|patch|refactor|migrate|upgrade|update\s+dependency)\b/i.test(
      task,
    )
  )
    return 'execute'
  if (/\b(create|write|build|add|make)\s+(a|the|this|an?)\b/i.test(task))
    return 'execute'
  if (/\b(run|execute)\s+(npm\s+test|pytest|tests?|the\s+test)\b/i.test(task))
    return 'execute'
  if (
    /\b(change|modify|edit|rewrite|replace|remove|delete|revert|apply|set\s+up)\b/i.test(
      task,
    )
  )
    return 'execute'

  // Question/understanding patterns → explain
  if (
    /^(what|how|why|does|can\s+you\s+explain|describe|tell\s+me\s+about|show\s+me\s+how)\b/i.test(
      task,
    )
  )
    return 'explain'
  if (
    /\b(explain|what\s+does|how\s+does|what\s+is|document|summarize)\b/i.test(
      task,
    )
  )
    return 'explain'
  // Read-only file inspection verbs → explain (unless paired with edit intent)
  if (
    /\b(read|list|show|cat|head|tail|display|print|output)\b/i.test(task) &&
    !/\b(and\s+(fix|edit|modify|change|update|write|patch|repair)|then\s+(fix|edit|modify)|fix\s+it)\b/i.test(
      task,
    )
  )
    return 'explain'

  // Default: peer-engineer posture — assume user wants execution
  return 'execute'
}
