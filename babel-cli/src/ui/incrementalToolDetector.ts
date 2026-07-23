import { createHash } from 'node:crypto';

export class JitDenialError extends Error {
  constructor(
    public readonly tool: string,
    public readonly target: string,
    public readonly args: any,
  ) {
    super(`[JIT_DENIED] Tool execution denied by user: ${tool} on target: ${target}`);
    this.name = 'JitDenialError';
  }
}

export class PolicyBlockedDuplicateError extends Error {
  constructor(
    public readonly tool: string,
    public readonly target: string,
    public readonly fingerprint: string,
  ) {
    super(
      `[POLICY_BLOCKED_DUPLICATE] Duplicate tool execution blocked: ${tool} on target: ${target}`,
    );
    this.name = 'PolicyBlockedDuplicateError';
  }
}

export interface PartialToolIntent {
  tool: string;
  target: string;
  args: Record<string, any>;
  rawSlice: string;
}

function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = sortObjectKeys(obj[key]);
  }
  return result;
}

export function computeFingerprint(
  tool: string,
  target: string,
  args: Record<string, any>,
): string {
  const cleanTarget = String(target || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  const cleanArgs = { ...args };
  delete cleanArgs.thinking; // Remove monologue for invariant hash comparison
  const sortedArgs = sortObjectKeys(cleanArgs);
  const data = `${tool}|${cleanTarget}|${JSON.stringify(sortedArgs)}`;
  return createHash('sha256').update(data).digest('hex');
}

export function autoCloseJson(str: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}') {
        if (stack[stack.length - 1] === '}') stack.pop();
      } else if (char === ']') {
        if (stack[stack.length - 1] === ']') stack.pop();
      }
    }
  }

  let closed = str;
  if (inString) {
    if (escape) {
      closed = closed.slice(0, -1);
    }
    closed += '"';
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    closed += stack[i];
  }
  return closed;
}

export function getTargetFromToolCall(toolCall: any): string | undefined {
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  return (
    toolCall.path ||
    toolCall.command ||
    toolCall.url ||
    toolCall.server ||
    toolCall.query ||
    toolCall.name ||
    toolCall.uri
  );
}

export class IncrementalToolDetector {
  private buffer = '';
  private insideFence = false;
  private hasEmittedIntent = false;
  private startTag = '<|tool_start|>';
  private endTag = '<|tool_end|>';

  // Scanner state
  private depth = 0;
  private inString = false;
  private escape = false;
  private startedObject = false;
  private scanIndex = 0;
  private fenceTimeout: NodeJS.Timeout | null = null;
  private feedQueue: Promise<void> = Promise.resolve();

  public peakBufferBytes = 0;
  public toolStartDetectedAt: number | null = null;
  public jitLatencyMs = 0;

  constructor(private onIntent: (intent: PartialToolIntent) => Promise<'approve' | 'deny'>) {}

  /**
   * Feed a chunk of streaming text into the detector.
   *
   * Serialized via a promise-chain mutex: concurrent calls are queued and
   * processed one at a time, preventing re-entrancy corruption of scanner
   * state (this.buffer, this.scanIndex, this.depth, this.inString, etc.)
   * when tryEmitIntent() suspends on the async onIntent callback.
   */
  public async feed(chunk: string): Promise<void> {
    this.feedQueue = this.feedQueue.then(() => this.feedImpl(chunk));
    return this.feedQueue;
  }

  private async feedImpl(chunk: string): Promise<void> {
    this.buffer += chunk;
    const currentBytes = Buffer.byteLength(this.buffer, 'utf8');
    if (currentBytes > this.peakBufferBytes) {
      this.peakBufferBytes = currentBytes;
    }

    // Buffer safety cap
    if (this.buffer.length > 16384) {
      this.resetAndFlush();
      return;
    }

    if (!this.insideFence) {
      const startIndex = this.buffer.indexOf(this.startTag);
      if (startIndex !== -1) {
        this.insideFence = true;
        this.toolStartDetectedAt = Date.now();
        this.jitLatencyMs = 0;
        this.hasEmittedIntent = false;
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        this.startedObject = false;
        this.scanIndex = 0;
        this.buffer = this.buffer.slice(startIndex + this.startTag.length);

        if (this.fenceTimeout) clearTimeout(this.fenceTimeout);
        this.fenceTimeout = setTimeout(() => {
          this.resetAndFlush();
        }, 2000);
      }
    }

    if (this.insideFence) {
      while (this.scanIndex < this.buffer.length) {
        const i = this.scanIndex;
        const char = this.buffer[i];

        // Check for end tag first
        if (this.buffer.slice(i, i + this.endTag.length) === this.endTag) {
          if (!this.hasEmittedIntent) {
            await this.tryEmitIntent(this.buffer.slice(0, i));
          }
          this.insideFence = false;
          if (this.fenceTimeout) {
            clearTimeout(this.fenceTimeout);
            this.fenceTimeout = null;
          }
          this.buffer = this.buffer.slice(i + this.endTag.length);
          this.scanIndex = 0;
          break;
        }

        // Process state transition
        if (this.escape) {
          this.escape = false;
          this.scanIndex++;
          continue;
        }

        if (char === '\\') {
          this.escape = true;
          this.scanIndex++;
          continue;
        }

        if (char === '"') {
          this.inString = !this.inString;
          this.scanIndex++;
          continue;
        }

        if (!this.inString) {
          if (char === '{' || char === '[') {
            this.depth++;
            this.startedObject = true;
          } else if (char === '}' || char === ']') {
            this.depth = Math.max(0, this.depth - 1);
            if (this.startedObject && this.depth === 0) {
              const jsonSlice = this.buffer.slice(0, i + 1);
              await this.tryEmitIntent(jsonSlice);
            }
          }
        }

        this.scanIndex++;
      }
    }
  }

  private async tryEmitIntent(jsonSlice: string): Promise<void> {
    if (this.hasEmittedIntent) return;
    try {
      const closedJson = autoCloseJson(jsonSlice);
      const parsed = JSON.parse(closedJson);
      if (parsed && typeof parsed === 'object' && parsed.type === 'tool_call' && parsed.tool) {
        const target = getTargetFromToolCall(parsed);
        if (target) {
          this.hasEmittedIntent = true;
          if (this.fenceTimeout) {
            clearTimeout(this.fenceTimeout);
            this.fenceTimeout = null;
          }
          if (this.toolStartDetectedAt) {
            this.jitLatencyMs = Date.now() - this.toolStartDetectedAt;
          }
          const decision = await this.onIntent({
            tool: parsed.tool,
            target,
            args: parsed,
            rawSlice: jsonSlice,
          });
          if (decision === 'deny') {
            throw new JitDenialError(parsed.tool, target, parsed);
          }
        }
      }
    } catch (e) {
      if (e instanceof JitDenialError || e instanceof PolicyBlockedDuplicateError) {
        throw e;
      }
      // Ignore intermediate parse failures
    }
  }

  private resetAndFlush(): void {
    if (this.fenceTimeout) {
      clearTimeout(this.fenceTimeout);
      this.fenceTimeout = null;
    }
    this.insideFence = false;
    this.hasEmittedIntent = false;
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.startedObject = false;
    this.scanIndex = 0;
    this.buffer = '';
  }
}
