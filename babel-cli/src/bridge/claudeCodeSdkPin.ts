import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface ClaudeAgentSdkPin {
  sdkPackage: string;
  sdkVersion: string;
  cliVersion: string;
  platformPackagePrefix: string;
}

const PIN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'claude-agent-sdk-pin.json');

export function loadClaudeAgentSdkPin(): ClaudeAgentSdkPin {
  const raw = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as ClaudeAgentSdkPin;
  return raw;
}
