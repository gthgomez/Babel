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
  // A reply consisting entirely of a product-choice question already asks the
  // user to decide. Do not require a second, stock "I need your choice" sentence.
  // This recognizes a deferral only: no authority or completion evidence is minted.
  const question = prose.trim().replace(/^>\s*/, '').replace(/^\*\*([\s\S]*)\*\*$/, '$1')
  const asksChoice = /\b(?:or|versus)\b/i.test(question)
    || /^(?:which|what)\b[^?\n]*\b(?:should|must)\b/i.test(question)
  if (asksChoice && /^(?:which|what|should|do you want|would you prefer)\b[^?\n]{1,300}\?$/i.test(question)) return true
  const deferral = /\b(?:I(?:'m| am) not (?:editing|implementing|changing)(?: anything)? yet|before I (?:can )?(?:edit|implement|proceed)|I (?:need|require) (?:your|a) (?:decision|choice|clarification)|what I need from you)\b/i.test(prose)
  if (!deferral || /\b(?:if|suppose|imagine)\b[^.!?\n]*\b(?:not editing|before I|I need|what I need)\b/i.test(prose)) return false
  // A blockquoted question can be the assistant's own prominently displayed request.
  return /(?:^|[.!\n])\s*(?:>\s*)?(?:\*\*)?(?:which|what|how|should|do you want|would you like|can you (?:choose|clarify|specify)|sort by|choose|specify|pick)\b[^?\n]{1,300}\?/im.test(prose)
}
