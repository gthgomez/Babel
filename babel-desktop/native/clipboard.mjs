// License: Apache-2.0 — see LICENSE
/** Text-only write boundary. The caller must validate the IPC sender. */
export function writeClipboardText(clipboard, text) {
  if (typeof text !== 'string' || !text.length || text.length > 250000 || text.includes('\0')) {
    throw new TypeError('Invalid clipboard text');
  }
  try { clipboard.writeText(text); }
  catch { throw new Error('Clipboard unavailable. Select and copy the message text.'); }
  return true;
}
