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

async function inflateBounded(
  encoded: Buffer,
  maxDecodedBytes: number,
  signal: AbortSignal,
  mode: 'gzip' | 'deflate',
): Promise<Buffer> {
  assertNotAborted(signal)
  const chunks: Buffer[] = []
  let decodedBytes = 0
  const source = Readable.from(encoded)
  const decompressor = mode === 'gzip' ? createGunzip() : createInflate()
  const onAbort = () => {
    source.destroy()
    decompressor.destroy()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    decompressor.on('data', (chunk: Buffer) => {
      decodedBytes += chunk.length
      if (decodedBytes > maxDecodedBytes) {
        decompressor.destroy(
          new AdmittedContentCodingError(
            'decompression_limit_exceeded',
            `decoded body exceeds limit of ${maxDecodedBytes} bytes`,
          ),
        )
        return
      }
      chunks.push(chunk)
    })
    await pipeline(source, decompressor)
    return Buffer.concat(chunks)
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
}

/**
 * Decode HTTP response bytes per Content-Encoding (gzip/deflate). Identity passes through.
 * Enforces decoded byte cap and honors abort while decompressing.
 */
export async function decodeAdmittedHttpBody(params: {
  encodedBody: Buffer
  contentEncodingHeader: string | string[] | undefined
  maxDecodedBytes: number
  signal: AbortSignal
}): Promise<{ buffer: Buffer; transportCoding: AdmittedHttpTransportCoding | null }> {
  const encodings = parseContentEncodings(params.contentEncodingHeader)
  if (encodings.length === 0) {
    return {
      buffer: params.encodedBody,
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
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i]!
    assertNotAborted(params.signal)
    const mode = encoding === 'deflate' ? 'deflate' : 'gzip'
    working = await inflateBounded(working, params.maxDecodedBytes, params.signal, mode)
  }

  return {
    buffer: working,
    transportCoding: {
      content_encodings: chain,
      encoded_byte_length: params.encodedBody.byteLength,
      decoded_byte_length: working.byteLength,
      admitted_representation: 'decoded_bytes',
    },
  }
}
