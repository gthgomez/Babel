import { Marked, type Token, type Tokens } from 'marked'

const markdown = new Marked()
const instruction = /\b(?:run|execute|verify|verifier\s+(?:commands?|is))\b/i
const commandStart = /^(?:npm|npx|pnpm|yarn|node|pytest|python\d*|go|cargo|make|bash|sh|pwsh)\b/i

/**
 * Project task prose used to infer mandatory verification. Quoted instructions,
 * examples, negations and explicitly availability-dependent requests are not
 * mandatory contracts. Explicit host-bound commands bypass this projection.
 */
export function mandatoryVerifierProse(task: string): string {
  const literals: string[] = []
  const protect = (text: string): string => `\uE000${literals.push(text) - 1}\uE001`
  const prose = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === 'code' || token.type === 'blockquote' || token.type === 'html') return '\n'
    // Keep command atoms (`npm run test`) intact, not imperative examples.
    if (token.type === 'codespan') return commandStart.test(token.text) || !instruction.test(token.text)
      ? protect(token.text) : ' '
    if (token.type === 'list') return token.items.map((item: Tokens.ListItem) => prose(item.tokens)).join('\n')
    if ('tokens' in token && token.tokens) return prose(token.tokens)
    return token.raw
  }).join('')
  const text = prose(markdown.lexer(task.replace(/\r\n?/g, '\n')))
  let quoteContext = ''
  let quoteEnd = 0
  return text
    .replace(/(["“])([^"”\n]+)["”]|(?:^|\s)'([^'\n]+)'/g, (whole, _quote, double, single, offset: number) => {
      const content = double ?? single ?? ''
      // Prior quoted arguments are opaque: their punctuation cannot end a command.
      quoteContext += text.slice(quoteEnd, offset)
      const prefix = (quoteContext.split(/[\n;]|[.!?](?=\s|$)/).at(-1) ?? '')
        .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
          const literal = literals[Number(index)] ?? ''
          return commandStart.test(literal) ? literal.split(/\s/)[0]! : 'quoted_literal'
        })
      quoteEnd = offset + whole.length
      quoteContext += ' quoted_argument '
      const commandArgument = /\b(?:verifier\s+commands?\s*:|verifier\s+(?:is|:)|(?:run|execute)\s+(?:npm|npx|pnpm|yarn|node|pytest|python\d*|go|cargo|make)\b)/i.test(prefix)
      return commandArgument || commandStart.test(content) || !instruction.test(content) ? protect(whole) : ' '
    })
    .split(/(\n|;|[.!?](?=\s|$)|\b(?:but|however|and)\b)/i)
    .map(clause => {
      // Only an immediately qualified verifier request is optional. Availability
      // of documentation or a later action must never erase a mandatory test.
      clause = clause.replace(/\b(?:if|when)\s+(?:available|possible|feasible)\s*,?\s*(?:please\s+)?(?:run|execute|verify)\b[^,;\n.!?]*/gi, '')
      clause = clause.replace(/\b(?:run|execute)\s+(?:(?:the|existing|targeted|relevant|unit|integration)\s+)*(?:tests?|lint|npm\s+(?:test|run\s+[\w:.-]+)|pytest|cargo\s+test|make\s+test|\uE000\d+\uE001)\s+(?:if|when)\s+(?:available|possible|feasible)\b(?:\s+before\s+completing\b)?/gi, '')
      return clause.replace(/\b(?:do\s+not|don['’]t|never|skip|avoid)\s+(?:(?:run|running|execute|executing|verify|verifying)\b)[^,]*/i, '')
    }).join('')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => literals[Number(index)] ?? '')
}
