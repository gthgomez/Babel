/**
 * LSP stdio framing: LSP requires LSP-style `Content-Length` headers
 * (`Content-Length: <bytes>\r\n\r\n<body>`), not MCP's newline-delimited JSON.
 *
 * This codec is deliberately separate from `src/mcp/framing.ts` so a transport
 * contract change cannot silently alter LSP wire behavior.
 */

/** Maximum accepted size of a complete LSP header block, including CRLFs. */
export const LSP_MAX_HEADER_BYTES = 16 * 1024

/** Maximum accepted size of one complete LSP message body. */
export const LSP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** Hard ceiling for unparsed bytes retained between reads. */
export const LSP_MAX_BUFFER_BYTES = LSP_MAX_MESSAGE_BYTES + LSP_MAX_HEADER_BYTES + 8

/** Raised when a peer exceeds an LSP framing memory ceiling. */
export class LspFrameLimitError extends Error {
  public readonly code = 'lsp_frame_limit_exceeded'

  public constructor(message: string) {
    super(message)
    this.name = 'LspFrameLimitError'
  }
}

/** Frame one JSON-RPC message for the LSP stdio transport. */
export function frameLspMessage(messageBody: string): string {
  if (/[\r\n]/u.test(messageBody)) {
    throw new Error('LSP stdio frames must not contain embedded newlines.')
  }
  const byteLength = Buffer.byteLength(messageBody, 'utf8')
  if (byteLength > LSP_MAX_MESSAGE_BYTES) {
    throw new LspFrameLimitError(
      `LSP message body exceeds the ${LSP_MAX_MESSAGE_BYTES}-byte limit.`,
    )
  }
  return `Content-Length: ${byteLength}\r\n\r\n${messageBody}`
}

export interface ParsedLspMessages {
  messages: Array<Record<string, unknown>>
  /** Bytes belonging to an incomplete trailing frame. */
  remainder: Buffer
}

/**
 * Consume complete `Content-Length` frames from a byte buffer.
 *
 * @throws {LspFrameLimitError} when a complete or partial header, message, or
 * buffered remainder exceeds its memory ceiling.
 */
export function parseLspMessages(buffer: Uint8Array): ParsedLspMessages {
  const input = Buffer.from(buffer)
  const messages: Array<Record<string, unknown>> = []
  let offset = 0

  while (offset < input.length) {
    const headerEnd = input.indexOf('\r\n\r\n', offset)
    if (headerEnd === -1) {
      if (input.length - offset > LSP_MAX_HEADER_BYTES) {
        throw new LspFrameLimitError(
          `Buffered LSP header exceeds the ${LSP_MAX_HEADER_BYTES}-byte limit.`,
        )
      }
      break
    }

    const headerLength = headerEnd - offset + 4
    if (headerLength > LSP_MAX_HEADER_BYTES) {
      throw new LspFrameLimitError(`LSP header exceeds the ${LSP_MAX_HEADER_BYTES}-byte limit.`)
    }

    const headerText = input.subarray(offset, headerEnd).toString('utf8')
    const contentLengthMatch = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/iu.exec(headerText)
    if (!contentLengthMatch) {
      throw new Error('Missing Content-Length header in LSP response.')
    }
    const contentLength = Number.parseInt(contentLengthMatch[1]!, 10)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error('Invalid Content-Length header in LSP response.')
    }
    if (contentLength > LSP_MAX_MESSAGE_BYTES) {
      throw new LspFrameLimitError(
        `LSP message body exceeds the ${LSP_MAX_MESSAGE_BYTES}-byte limit.`,
      )
    }

    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (input.length < bodyEnd) break

    const body = input.subarray(bodyStart, bodyEnd).toString('utf8')
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LSP frame did not contain a JSON object.')
    }
    messages.push(parsed as Record<string, unknown>)
    offset = bodyEnd
  }

  const remainder = input.subarray(offset)
  if (remainder.length > LSP_MAX_BUFFER_BYTES) {
    throw new LspFrameLimitError(
      `Buffered LSP input exceeds the ${LSP_MAX_BUFFER_BYTES}-byte limit.`,
    )
  }
  return { messages, remainder }
}
