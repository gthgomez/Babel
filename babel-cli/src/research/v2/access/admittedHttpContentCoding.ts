import { createGunzip, createInflate } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

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
  /** When true, decoded_byte_length is bytes observed before early stop (lower bound on full stream). */
  decoded_byte_length_is_lower_bound?: boolean
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
  decodedBytesObserved: number
  decodedByteLengthIsLowerBound: boolean
}

function destroyInflateEarly(
  source: Readable,
  decompressor: ReturnType<typeof createGunzip>,
): void {
  source.destroy()
  decompressor.destroy()
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
  let decodedBytesObserved = 0
  let decodedTruncated = false
  let stoppedEarly = false

  const source = Readable.from(encoded)
  const decompressor = mode === 'gzip' ? createGunzip() : createInflate()
  const onAbort = () => {
    destroyInflateEarly(source, decompressor)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const onData = (chunk: Buffer) => {
    decodedBytesObserved += chunk.length
    if (stoppedEarly) {
      return
    }
    const remaining = maxAdmittedDecodedBytes - storedBytes
    if (remaining <= 0) {
      stoppedEarly = true
      decodedTruncated = true
      destroyInflateEarly(source, decompressor)
      return
    }
    if (chunk.length <= remaining) {
      chunks.push(chunk)
      storedBytes += chunk.length
      return
    }
    chunks.push(chunk.subarray(0, remaining))
    storedBytes += remaining
    stoppedEarly = true
    decodedTruncated = true
    destroyInflateEarly(source, decompressor)
  }

  try {
    decompressor.on('data', onData)
    await pipeline(source, decompressor)
  } catch (err: unknown) {
    if (signal.aborted) {
      throw new AdmittedContentCodingError('aborted', 'content decoding aborted')
    }
    if (decodedTruncated) {
      // Early destroy after cap — expected.
    } else if (err instanceof AdmittedContentCodingError) {
      throw err
    } else {
      throw new AdmittedContentCodingError(
        'malformed_encoding',
        err instanceof Error ? err.message : String(err),
      )
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    decompressor.off('data', onData)
  }

  const buffer: Buffer = Buffer.concat(chunks)

  return {
    buffer,
    decodedTruncated,
    decodedBytesObserved,
    decodedByteLengthIsLowerBound: decodedTruncated,
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
  let decodedBytesObserved = 0
  let decodedByteLengthIsLowerBound = false
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i]!
    assertNotAborted(params.signal)
    const mode = encoding === 'deflate' ? 'deflate' : 'gzip'
    const inflated = await inflateBounded(working, params.maxDecodedBytes, params.signal, mode)
    working = inflated.buffer
    decodedTruncated = inflated.decodedTruncated
    decodedBytesObserved = inflated.decodedBytesObserved
    decodedByteLengthIsLowerBound = inflated.decodedByteLengthIsLowerBound
  }

  return {
    buffer: working,
    decodedTruncated,
    transportCoding: {
      content_encodings: chain,
      encoded_byte_length: params.encodedBody.byteLength,
      decoded_byte_length: decodedBytesObserved,
      admitted_representation: 'decoded_bytes',
      ...(decodedTruncated
        ? {
            decoded_truncated: true,
            admitted_decoded_byte_length: working.byteLength,
            decoded_byte_length_is_lower_bound: decodedByteLengthIsLowerBound,
          }
        : {}),
    },
  }
}
