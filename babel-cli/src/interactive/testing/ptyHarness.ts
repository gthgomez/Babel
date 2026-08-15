/**
 * Virtual PTY / Interactive Stream Testing Harness.
 *
 * Provides in-process TTY stream simulation for testing readline, ANSI rendering,
 * resize handling, Ctrl+C / SIGINT simulation, paste bursts, and terminal mode restoration.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { stripAnsi } from '../../ui/theme.js';

export interface VirtualTerminalOptions {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

export class VirtualTerminal extends EventEmitter {
  public columns: number;
  public rows: number;
  public isTTY: boolean;
  public isRaw: boolean = false;
  public cursorVisible: boolean = true;

  public readonly stdin: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  public readonly stdout: Writable & { columns?: number; rows?: number; isTTY?: boolean };
  public readonly stderr: Writable & { columns?: number; rows?: number; isTTY?: boolean };

  private outputBuffer: string[] = [];
  private rawOutputBuffer: string[] = [];
  private inputEmitter = new EventEmitter();

  constructor(options: VirtualTerminalOptions = {}) {
    super();
    this.columns = options.columns ?? 80;
    this.rows = options.rows ?? 24;
    this.isTTY = options.isTTY ?? true;

    // Simulated stdin
    const inputStream = new PassThrough();
    this.stdin = Object.assign(inputStream, {
      isTTY: this.isTTY,
      setRawMode: (mode: boolean) => {
        this.isRaw = mode;
        this.emit('rawModeChanged', mode);
      },
    });

    // Simulated stdout
    const self = this;
    const outputStream = new Writable({
      write(chunk, encoding, callback) {
        const str = chunk.toString();
        self.rawOutputBuffer.push(str);
        self.outputBuffer.push(stripAnsi(str));
        self.emit('data', str);
        callback();
      },
    });
    this.stdout = Object.assign(outputStream, {
      columns: this.columns,
      rows: this.rows,
      isTTY: this.isTTY,
    });

    // Simulated stderr
    const errStream = new Writable({
      write(chunk, encoding, callback) {
        const str = chunk.toString();
        self.rawOutputBuffer.push(str);
        self.outputBuffer.push(stripAnsi(str));
        self.emit('stderr', str);
        callback();
      },
    });
    this.stderr = Object.assign(errStream, {
      columns: this.columns,
      rows: this.rows,
      isTTY: this.isTTY,
    });
  }

  public sendInput(text: string): void {
    this.stdin.push(text);
  }

  public sendLine(line: string): void {
    this.stdin.push(`${line}\n`);
  }

  public sendCtrlC(): void {
    // Send 0x03 byte (ETX / Ctrl+C)
    this.stdin.push('\u0003');
    this.emit('sigint');
  }

  public sendPasteBurst(lines: readonly string[]): void {
    // Simulate bracketed paste or fast burst input
    const burst = lines.join('\n');
    this.stdin.push(burst);
  }

  public resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    (this.stdout as any).columns = columns;
    (this.stdout as any).rows = rows;
    this.emit('resize', { columns, rows });
  }

  public getCleanOutput(): string {
    return this.outputBuffer.join('');
  }

  public getRawOutput(): string {
    return this.rawOutputBuffer.join('');
  }

  public clearOutput(): void {
    this.outputBuffer = [];
    this.rawOutputBuffer = [];
  }

  public async waitForOutput(pattern: RegExp | string, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = this.getCleanOutput();
      if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }
}
