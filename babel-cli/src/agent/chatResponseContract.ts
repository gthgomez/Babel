/** Only authentic current-user prose can impose a bare JSON answer contract. */
export function requestedChatJsonKind(userInput: string): 'object' | 'array' | null {
  const request = userInput.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '')
    .replace(/["“][^"”]*["”]/g, '')
  const kind = /\b(?:return|respond|reply|output)\s+(?:with\s+)?only\s+(?:a\s+)?(?:valid\s+)?JSON\s+(object|array)\b/i.exec(request)?.[1]?.toLowerCase()
  return kind === 'object' || kind === 'array' ? kind : null
}

/** Apply only an explicit current-user output contract; never extract or invent data. */
export function normalizeChatAnswer(answer: string, userInput: string): string {
  const kind = requestedChatJsonKind(userInput)
  if (!kind) return answer
  const fence = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(answer)
  if (!fence?.[1] || fence[1].includes('```')) return answer
  try {
    const value: unknown = JSON.parse(fence[1])
    if (value === null || typeof value !== 'object' || Array.isArray(value) !== (kind === 'array')) return answer
    // Keep the payload's original bytes, including its newline before the fence.
    return fence[1] + (answer.includes('\r\n') ? '\r\n' : '\n')
  } catch { return answer }
}

/** An assistant's blocking choice question is a deferral, not proof of task completion. */
export function requestsRequiredUserDecision(answer: string): boolean {
  const prose = answer.replace(/```[\s\S]*?```/g, '')
    .replace(/\b(?:says?|said|claims?|claimed|wrote)\s*[: ,]*["“][^"”]*["”]/gi, '')
  // Remove only a conditional clause that itself contains deferral language.
  // Keeping the rest of the sentence avoids erasing a current blocker after an
  // unrelated 'if' clause, and matching from 'if' avoids abbreviation issues.
  const conditionalClause = /\b(?:if|suppose|imagine)\b[^,;.!?\n]*(?:[,;.!?]|$)/gim
  const deferralPhrase = /\b(?:not editing|before I|I need|what I need|cannot proceed without|can't proceed without)\b/i
  const conditionalMatches = [...prose.matchAll(conditionalClause)]
    .filter(match => deferralPhrase.test(match[0]))
  let currentProse = prose
  for (const match of [...conditionalMatches].sort((left, right) => (right.index ?? -1) - (left.index ?? -1))) {
    const start = match.index
    if (start === undefined) continue
    currentProse = currentProse.slice(0, start) + ' ' + currentProse.slice(start + match[0].length)
  }
  // A reply consisting entirely of a product-choice question already asks the
  // user to decide. Do not require a second, stock "I need your choice" sentence.
  // This recognizes a deferral only: no authority or completion evidence is minted.
  const question = currentProse.trim().replace(/^>\s*/, '').replace(/^\*\*([\s\S]*)\*\*$/, '$1')
  const directQuestion = /^(?:which|what|should|do you want|would you prefer)\b[^?\n]{1,300}\?/i.exec(question)?.[0]
  const asksChoice = directQuestion !== undefined && (
    /\b(?:or|versus)\b/i.test(directQuestion)
    || /^(?:which|what)\b[^?\n]*\b(?:should|must)\b/i.test(directQuestion)
  )
  if (asksChoice && directQuestion) {
    const questionStart = prose.indexOf(directQuestion)
    const followsHypothetical = conditionalMatches.some(match => match.index !== undefined && match.index < questionStart)
    if (!followsHypothetical) return true
  }
  const deferral = /\b(?:I(?:'m| am) not (?:editing|implementing|changing)(?: anything)? yet|before I (?:can )?(?:edit|implement|proceed)|I (?:need|require) (?:your|a) (?:decision|choice|clarification)|I (?:cannot|can't) proceed(?: with (?:this|the) task)? without (?:a|your) (?:decision|choice|clarification)|what I need from you)\b/i.test(currentProse)
  if (!deferral) return false
  // A blockquoted question can be the assistant's own prominently displayed request.
  return /(?:^|[.!\n])\s*(?:>\s*)?(?:\*\*)?(?:which|what|how|should|do you want|would you like|can you (?:choose|clarify|specify)|sort by|choose|specify|pick)\b[^?\n]{1,300}\?/im.test(currentProse)
}
