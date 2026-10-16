// Stream canonical JSONL without retaining the archive or an unbounded malformed line.
const CHUNK_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_LINE_BYTES = 4 * 1024 * 1024;

export async function scanTranscript(handle, byteLength, parse, visit) {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0, fragments = [], lineBytes = 0, oversized = false, skippedOversizedLines = 0;
  const finish = () => {
    if (oversized) skippedOversizedLines++;
    else {
      const message = parse(Buffer.concat(fragments, lineBytes).toString('utf8'));
      if (message) visit(message);
    }
    fragments = []; lineBytes = 0; oversized = false;
  };
  while (position < byteLength) {
    const {bytesRead} = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, byteLength - position), position);
    if (!bytesRead) break;
    position += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const newline = buffer.indexOf(10, start);
      const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
      if (!oversized) {
        lineBytes += end - start;
        if (lineBytes > MAX_TRANSCRIPT_LINE_BYTES) { oversized = true; fragments = []; }
        else fragments.push(Buffer.from(buffer.subarray(start, end)));
      }
      if (end < bytesRead) finish();
      start = end + 1;
    }
  }
  if (lineBytes || oversized) finish();
  return {skippedOversizedLines};
}

/** Two bounded passes over the same open file snapshot; pagination memory is independent of offset. */
export async function readTranscriptPage(handle, byteLength, parse, {limit, olderOffset}) {
  let total = 0;
  const diagnostics = await scanTranscript(handle, byteLength, parse, () => total++);
  const windowEnd = Math.max(0, total - olderOffset);
  const windowStart = Math.max(0, windowEnd - limit);
  const messages = [];
  let index = 0;
  await scanTranscript(handle, byteLength, parse, message => {
    if (index >= windowStart && index < windowEnd) messages.push({...message,messageIndex:index});
    index++;
  });
  return {messages, total, windowStart, windowEnd, hasOlder: windowStart > 0, ...diagnostics};
}
