import { createGunzip, createInflate } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { utf8SafeBytePrefix } from './utf8SafeBytePrefix.js'

export class AdmittedContentCodingError extends Error {
  readonly code: 'unsupported_encoding' | 'malformed_encoding' | 'decompression_limit_exceeded' | 'aborted'

  constructor(
    code: 'unsupported_encoding' | 'malformed_encoding' | 'decompression_limit_exceeded' | 'aborted',
    message: string,
  ) {
    super(message)
    this.name = 'AdmittedContentCodingError'
    this.code = code
  }
}

export interface AdmittedHttpTransportCoding {
  content_encodings: string[]
  encoded_byte_length: number
  decoded_byte_length: number
  admitted_representation: 'decoded_bytes'
  decoded_truncated?: boolean
  admitted_decoded_byte_length?: number
}

export function parseContentEncodings(
  header: string | string[] | undefined,
): string[] {
  if (!header) return []
  const raw = Array.isArray(header) ? header.join(',') : header
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part !== 'identity')
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AdmittedContentCodingError('aborted', 'content decoding aborted')
  }
}

interface InflateBoundedResult {
  buffer: Buffer
  decodedTruncated: boolean
  decodedBytesTotal: number
}

async function inflateBounded(
  encoded: Buffer,
  maxAdmittedDecodedBytes: number,
  signal: AbortSignal,
  mode: 'gzip' | 'deflate',
): Promise<InflateBoundedResult> {
  assertNotAborted(signal)
  const chunks: Buffer[] = []
  let storedBytes = 0
  let decodedBytesTotal = 0
  let decodedTruncated = false
  let stopStoring = false

  const source = Readable.from(encoded)
  const decompressor = mode === 'gzip' ? createGunzip() : createInflate()
  const onAbort = () => {
    source.destroy()
    decompressor.destroy()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    decompressor.on('data', (chunk: Buffer) => {
      decodedBytesTotal += chunk.length
      if (stopStoring) {
        return
      }
      const remaining = maxAdmittedDecodedBytes - storedBytes
      if (remaining <= 0) {
        stopStoring = true
        decodedTruncated = true
        return
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        storedBytes += chunk.length
        return
      }
      chunks.push(chunk.subarray(0, remaining))
      storedBytes += remaining
      stopStoring = true
      decodedTruncated = true
    })
    await pipeline(source, decompressor)
  } catch (err: unknown) {
    if (signal.aborted) {
      throw new AdmittedContentCodingError('aborted', 'content decoding aborted')
    }
    if (err instanceof AdmittedContentCodingError) {
      throw err
    }
    throw new AdmittedContentCodingError(
      'malformed_encoding',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
  }

  let buffer: Buffer = Buffer.concat(chunks)
  if (decodedTruncated) {
    buffer = Buffer.from(utf8SafeBytePrefix(buffer, maxAdmittedDecodedBytes))
  }

  return {
    buffer,
    decodedTruncated,
    decodedBytesTotal,
  }
}

/**
 * Decode HTTP response bytes per Content-Encoding (gzip/deflate). Identity passes through.
 * Enforces decoded admission cap with truthful truncation metadata; honors abort while decompressing.
 */
export async function decodeAdmittedHttpBody(params: {
  encodedBody: Buffer
  contentEncodingHeader: string | string[] | undefined
  maxDecodedBytes: number
  signal: AbortSignal
}): Promise<{
  buffer: Buffer
  decodedTruncated: boolean
  transportCoding: AdmittedHttpTransportCoding | null
}> {
  const encodings = parseContentEncodings(params.contentEncodingHeader)
  if (encodings.length === 0) {
    return {
      buffer: params.encodedBody,
      decodedTruncated: false,
      transportCoding: null,
    }
  }
  for (const encoding of encodings) {
    if (encoding === 'br' || encoding === 'zstd') {
      throw new AdmittedContentCodingError(
        'unsupported_encoding',
        `unsupported Content-Encoding "${encoding}"`,
      )
    }
    if (encoding !== 'gzip' && encoding !== 'deflate' && encoding !== 'x-gzip') {
      throw new AdmittedContentCodingError(
        'unsupported_encoding',
        `unsupported Content-Encoding "${encoding}"`,
      )
    }
  }

  let working = params.encodedBody
  const chain: string[] = [...encodings]
  let decodedTruncated = false
  let decodedBytesTotal = 0
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i]!
    assertNotAborted(params.signal)
    const mode = encoding === 'deflate' ? 'deflate' : 'gzip'
    const inflated = await inflateBounded(working, params.maxDecodedBytes, params.signal, mode)
    working = inflated.buffer
    decodedTruncated = inflated.decodedTruncated
    decodedBytesTotal = inflated.decodedBytesTotal
  }

  return {
    buffer: working,
    decodedTruncated,
    transportCoding: {
      content_encodings: chain,
      encoded_byte_length: params.encodedBody.byteLength,
      decoded_byte_length: decodedBytesTotal,
      admitted_representation: 'decoded_bytes',
      ...(decodedTruncated
        ? {
            decoded_truncated: true,
            admitted_decoded_byte_length: working.byteLength,
          }
        : {}),
    },
  }
}
