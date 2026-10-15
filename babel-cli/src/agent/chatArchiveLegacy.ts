import { readFileSync } from 'node:fs';
import {legacyArchiveToChatMessages} from './providerMessagesToChatMessages.js';

/** Preserve pre-canonical rows during adoption, with no invented event identities. */
export function retainedLegacyArchive(path: string, canonicalIds?: ReadonlySet<string>, options: {allowMissing?:boolean} = {}): Record<string, unknown>[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.allowMissing !== false) return []; throw error; }
  const legacy: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record: unknown = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid retained archive record');
    const value = record as Record<string, unknown>;
    if (value['archive_source'] === 'thread_events') {
      if (typeof value['source_event_id'] !== 'string' || !canonicalIds?.has(value['source_event_id'])) throw new Error('Canonical archive history is unavailable. Restore the matching event log or start a new chat; the retained transcript is unchanged.');
      continue;
    }
    if (value['archive_source'] !== undefined && value['archive_source'] !== 'legacy_transcript') throw new Error('Unsupported retained archive source');
    if (!['system', 'user', 'assistant', 'tool'].includes(String(value['role'])) || typeof value['content'] !== 'string') throw new Error('Invalid legacy archive message');
    legacy.push({...value, archive_source: 'legacy_transcript'});
  }
  return legacy;
}

/** Execution fallback accepts genuine legacy rows, never a detached display archive. */
export function readLegacyTranscriptForContext(path: string) {
  return legacyArchiveToChatMessages(retainedLegacyArchive(path,undefined,{allowMissing:false}),{includeSystem:true});
}
