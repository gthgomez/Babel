/**
 * MCP stdio framing shared by the Babel MCP server and client transport.
 *
 * The published MCP stdio transport carries one UTF-8 JSON-RPC message per
 * line (newline-delimited JSON). Legacy Babel peers used LSP-style
 * `Content-Length` framing; the reader keeps that as an explicitly bounded,
 * backwards-compatible input format, but every message this codebase writes
 * uses the standard newline-delimited form.
 */

/** Standard MCP stdio framing emitted by this transport. */
export const MCP_STDIO_FRAMING = 'newline-delimited-json'

/**
 * Explicit legacy input compatibility. Only readers accept `Content-Length`;
 * writers never emit it.
 */
export const MCP_LEGACY_CONTENT_LENGTH_INPUT_COMPAT = true

/** Maximum accepted size of one complete MCP frame body. */
export const MCP_MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Maximum accepted size of a legacy `Content-Length` header block. */
export const MCP_MAX_HEADER_BYTES = 16 * 1024

/** Hard ceiling for unparsed bytes retained between reads. */
export const MCP_MAX_BUFFER_BYTES = MCP_MAX_FRAME_BYTES + MCP_MAX_HEADER_BYTES + 8

/** Raised when a peer tries to exceed a framing memory ceiling. */
export class McpFrameLimitError extends Error {
  public readonly code = 'mcp_frame_limit_exceeded'

  public constructor(message: string) {
    super(message)
    this.name = 'McpFrameLimitError'
  }
}

/** Result of consuming every complete frame currently buffered. */
export interface ParsedMcpFrames {
  messages: Array<Record<string, unknown>>
  /** Invalid JSON bodies are reported without echoing the remote payload. */
  parseErrors: string[]
  /** Bytes belonging to an incomplete trailing frame. */
  remainder: Buffer
}

/** Frame one JSON-RPC message for the published MCP stdio transport. */
export function frameJsonRpcMessage(messageBody: string): string {
  if (/[\r\n]/u.test(messageBody)) {
    throw new Error('MCP stdio frames must not contain embedded newlines.')
  }
  const byteLength = Buffer.byteLength(messageBody, 'utf8')
  if (byteLength > MCP_MAX_FRAME_BYTES) {
    throw new McpFrameLimitError(`MCP frame body exceeds the ${MCP_MAX_FRAME_BYTES}-byte limit.`)
  }
  // JSON.stringify escapes embedded newlines, so one message is one line.
  return `${messageBody}\n`
}

function parseJsonObject(body: string, parseErrors: string[]): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parseErrors.push('Invalid JSON in MCP frame.')
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    parseErrors.push('MCP frame did not contain a JSON object.')
    return null
  }
  return parsed as Record<string, unknown>
}

/**
 * Consume complete newline-delimited JSON frames (and bounded legacy
 * `Content-Length` frames) from a byte buffer.
 *
 * @throws {McpFrameLimitError} when a header, frame, or buffered remainder
 * exceeds its memory ceiling.
 */
export function parseFramedMessages(buffer: Uint8Array): ParsedMcpFrames {
  const input = Buffer.from(buffer)
  const messages: Array<Record<string, unknown>> = []
  const parseErrors: string[] = []
  let offset = 0

  while (offset < input.length) {
    const lineEnd = input.indexOf(0x0a, offset)
    if (lineEnd === -1) {
      const pending = input.length - offset
      if (pending > MCP_MAX_FRAME_BYTES) {
        throw new McpFrameLimitError(
          `Buffered MCP frame exceeds the ${MCP_MAX_FRAME_BYTES}-byte limit.`,
        )
      }
      break
    }

    let contentEnd = lineEnd
    if (contentEnd > offset && input[contentEnd - 1] === 0x0d) contentEnd -= 1
    const firstLine = input.subarray(offset, contentEnd).toString('utf8')

    if (/^content-length\s*:/iu.test(firstLine)) {
      if (!MCP_LEGACY_CONTENT_LENGTH_INPUT_COMPAT) {
        throw new Error('Legacy MCP Content-Length framing is not accepted.')
      }
      const headerEnd = input.indexOf('\r\n\r\n', offset)
      if (headerEnd === -1) {
        if (input.length - offset > MCP_MAX_HEADER_BYTES) {
          throw new McpFrameLimitError(`MCP header exceeds the ${MCP_MAX_HEADER_BYTES}-byte limit.`)
        }
        break
      }
      const headerText = input.subarray(offset, headerEnd).toString('utf8')
      const contentLengthMatch = /content-length:\s*(\d+)/iu.exec(headerText)
      if (!contentLengthMatch) {
        throw new Error('Missing Content-Length header in MCP response.')
      }
      const contentLength = Number.parseInt(contentLengthMatch[1]!, 10)
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error('Invalid Content-Length header in MCP response.')
      }
      if (contentLength > MCP_MAX_FRAME_BYTES) {
        throw new McpFrameLimitError(
          `MCP frame body exceeds the ${MCP_MAX_FRAME_BYTES}-byte limit.`,
        )
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + contentLength
      if (input.length < bodyEnd) break

      const body = input.subarray(bodyStart, bodyEnd).toString('utf8')
      const message = parseJsonObject(body, parseErrors)
      if (message !== null) messages.push(message)
      offset = bodyEnd
      continue
    }

    if (contentEnd === offset) {
      // Tolerate blank separator lines between newline-delimited messages.
      offset = lineEnd + 1
      continue
    }
    const line = input.subarray(offset, contentEnd)
    if (line.length > MCP_MAX_FRAME_BYTES) {
      throw new McpFrameLimitError(`MCP frame body exceeds the ${MCP_MAX_FRAME_BYTES}-byte limit.`)
    }
    const message = parseJsonObject(line.toString('utf8'), parseErrors)
    if (message !== null) messages.push(message)
    offset = lineEnd + 1
  }

  const remainder = input.subarray(offset)
  if (remainder.length > MCP_MAX_BUFFER_BYTES) {
    throw new McpFrameLimitError(
      `Buffered MCP input exceeds the ${MCP_MAX_BUFFER_BYTES}-byte limit.`,
    )
  }
  return { messages, parseErrors, remainder }
}
