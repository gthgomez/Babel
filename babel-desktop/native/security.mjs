import { isAbsolute } from 'node:path';
export const APP_URL = 'babel://app/index.html';
export const REPOSITORY_URL = 'https://github.com/gthgomez/Babel';
export function isAppUrl(value) { return value === APP_URL; }
export function parsePreferences(value) {
  const clean = input => typeof input === 'string' && input.length < 2048 && !input.includes('\0') && isAbsolute(input) ? input : null;
  return {cliEntry:clean(value?.cliEntry),projectRoot:clean(value?.projectRoot)};
}
