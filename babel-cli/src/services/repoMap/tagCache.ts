import type { RepoTag } from './graph.js';

interface CacheEntry {
  hash: string;
  tags: RepoTag[];
  bytes: number;
}

/** A process-local, size- and count-bounded least-recently-used tag cache. */
export class RepoMapTagCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get(file: string): CacheEntry | undefined {
    const entry = this.entries.get(file);
    if (entry) {
      this.entries.delete(file);
      this.entries.set(file, entry);
    }
    return entry;
  }

  set(file: string, hash: string, tags: RepoTag[], sourceBytes = 0): void {
    this.delete(file);
    // Conservative accounting for the objects and retained identifier strings.
    // Identifier slices may retain the original source string in V8, so
    // account for the entire source as well as tag objects and names.
    const bytes = tags.reduce((sum, tag) => sum + 80 + tag.name.length * 2, file.length * 2 + sourceBytes * 2);
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(file, { hash, tags, bytes });
    this.bytes += bytes;
  }

  delete(file: string): void {
    const entry = this.entries.get(file);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(file);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { entries: number; estimatedBytes: number } {
    return { entries: this.entries.size, estimatedBytes: this.bytes };
  }
}
