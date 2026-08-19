/**
 * XSS-safe transcript rendering for the Remote V1 PWA.
 * Never assigns untrusted model/tool text to innerHTML.
 */

export interface SafeRenderTarget {
  appendChild(node: { nodeType: number }): unknown;
  textContent: string | null;
}

export interface SafeDocument {
  createElement(tag: string): SafeElement;
  createTextNode(text: string): { nodeType: number; textContent: string };
}

export interface SafeElement extends SafeRenderTarget {
  nodeType: number;
  className: string;
  setAttribute(name: string, value: string): void;
}

export function appendSafeText(target: SafeRenderTarget, text: string, doc: SafeDocument): void {
  target.appendChild(doc.createTextNode(text));
}

export function appendTranscriptEvent(
  target: SafeRenderTarget,
  event: { type: string; text?: string; tool?: string; target?: string; error?: string },
  doc: SafeDocument,
): void {
  const row = doc.createElement('div');
  row.className = 'event';
  row.setAttribute('data-type', event.type);
  const label = doc.createElement('strong');
  appendSafeText(label, event.type, doc);
  row.appendChild(label);
  const body = event.text ?? event.error ?? [event.tool, event.target].filter(Boolean).join(' ');
  if (body) {
    const pre = doc.createElement('pre');
    appendSafeText(pre, body, doc);
    row.appendChild(pre);
  }
  target.appendChild(row);
}

export function htmlLooksUnsafeForInnerHtml(html: string): boolean {
  return /<\s*script|on\w+\s*=|javascript:|data:text\/html/i.test(html);
}
