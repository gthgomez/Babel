import { StringDecoder } from 'node:string_decoder';

/** Bounded, incremental decoder for Babel's existing newline-delimited JSON. */
export class JsonlDecoder {
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #bytes = 0;
  #discarding = false;
  #ended = false;
  constructor(onEvent, onError, {maxLineBytes = 1024 * 1024} = {}) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 32) throw new TypeError('Invalid line limit');
    this.onEvent = onEvent;
    this.onError = onError;
    this.maxLineBytes = maxLineBytes;
  }
  push(chunk) {
    if (this.#ended) throw new Error('Decoder already ended');
    this.#accept(this.#decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }
  #accept(text) {
    // The caller supplies bounded chunks; an overlong line is discarded until LF.
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (!this.#discarding) {
        this.#bytes += Buffer.byteLength(parts[i], 'utf8');
        if (this.#bytes > this.maxLineBytes) {
          this.#discarding = true;
          this.#buffer = '';
          this.onError('CLI JSON line exceeds the display limit; line discarded.');
        } else this.#buffer += parts[i];
      }
      if (i < parts.length - 1) {
        if (!this.#discarding) this.#parse();
        this.#buffer = ''; this.#bytes = 0; this.#discarding = false;
      }
    }
  }
  #parse() {
    const text = this.#buffer.trim();
    if (!text) return;
    let value;
    try { value = JSON.parse(text); }
    catch { this.onError('CLI emitted a malformed JSON line.'); return; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.onError('CLI emitted a non-object JSON value.'); return;
    }
    this.onEvent(value);
  }
  end() {
    if (this.#ended) return;
    this.#accept(this.#decoder.end());
    if (!this.#discarding) this.#parse();
    this.#buffer = ''; this.#bytes = 0; this.#ended = true;
  }
}
