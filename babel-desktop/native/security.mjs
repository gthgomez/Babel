import { isAbsolute } from 'node:path';
import {isPinnedImage,validateSandboxImageReference} from './sandbox-setup.mjs';
export const APP_URL = 'babel://app/index.html';
export const REPOSITORY_URL = 'https://github.com/gthgomez/Babel';
export function isAppUrl(value) { return value === APP_URL; }
export function parsePreferences(value) {
  const clean = input => typeof input === 'string' && input.length < 2048 && !input.includes('\0') && isAbsolute(input) ? input : null;
  let reference=null;
  try{reference=validateSandboxImageReference(value?.sandboxImageReference);}catch{}
  return {cliEntry:clean(value?.cliEntry),projectRoot:clean(value?.projectRoot),projectCredentialRoot:clean(value?.projectCredentialRoot),
    sandboxImage:isPinnedImage(value?.sandboxImage)?value.sandboxImage:null,sandboxImageReference:reference};
}
