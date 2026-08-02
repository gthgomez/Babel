import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { SessionDescriptor } from "../../executor/contracts.js";
import { getThreadDir } from "./threadStore.js";

const SESSION_DESCRIPTOR_FILENAME = "session-descriptor.json";

function descriptorPath(threadId: string): string {
  return join(getThreadDir(threadId), SESSION_DESCRIPTOR_FILENAME);
}

/** Persist a reconstructible session descriptor using an atomic rename. */
export function writeSessionDescriptor(descriptor: SessionDescriptor): void {
  const path = descriptorPath(descriptor.threadId);
  mkdirSync(getThreadDir(descriptor.threadId), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(descriptor, null, 2)}\n`,
    "utf8",
  );
  renameSync(temporaryPath, path);
}

/** Load a session descriptor, returning null for legacy threads. */
export function loadSessionDescriptor(
  threadId: string,
): SessionDescriptor | null {
  const path = descriptorPath(threadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionDescriptor;
  } catch {
    return null;
  }
}
