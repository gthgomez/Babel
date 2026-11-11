/** Reconcile the visible conversation without replacing unchanged messages. */
export function createConversationDom(scroller) {
  let session = null;
  let emptyMarkup = null;
  let historyMarkup = null;
  let historyRoot = null;
  let records = new Map();

  function parse(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const node = template.content.firstElementChild;
    if (!node) throw new Error('Conversation message markup is empty');
    return node;
  }

  function identity(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return String(node.nodeType);
    const firstClass = node.getAttribute('class')?.split(/\s+/)[0] ?? '';
    return [node.tagName, firstClass, node.getAttribute('data-action') ?? '',
      node.getAttribute('data-id') ?? '', node.getAttribute('data-tool-key') ?? ''].join('|');
  }

  function syncText(current, next) {
    const before = current.data, after = next.data;
    if (before === after) return;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length-prefix && suffix < after.length-prefix &&
      before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
    // Append in place during streaming so a selection in existing text keeps
    // its original text node and offsets.
    current.replaceData(prefix, before.length-prefix-suffix, after.slice(prefix, after.length-suffix));
  }

  function sync(current, next) {
    if (current.nodeType === Node.TEXT_NODE) { syncText(current, next); return; }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of [...current.attributes]) {
      // The user, not a stream update, owns an opened details element.
      if (current.tagName === 'DETAILS' && attr.name === 'open') continue;
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of [...next.attributes]) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    let cursor = current.firstChild;
    for (const desired of [...next.childNodes]) {
      let match = cursor;
      if (!match || identity(match) !== identity(desired)) {
        match = cursor?.nextSibling ?? null;
        while (match && identity(match) !== identity(desired)) match = match.nextSibling;
        if (match) current.insertBefore(match, cursor);
        else {
          match = desired.cloneNode(true);
          current.insertBefore(match, cursor);
        }
      }
      sync(match, desired);
      cursor = match.nextSibling;
    }
    while (cursor) {
      const nextNode = cursor.nextSibling;
      current.removeChild(cursor);
      cursor = nextNode;
    }
  }

  return {
    render({currentSession, empty, history, messages, messageMarkup}) {
      if (session !== currentSession) {
        session = currentSession;
        emptyMarkup = null;
        historyMarkup = null;
        historyRoot = null;
        records = new Map();
        scroller.replaceChildren();
      }
      if (empty !== null) {
        if (emptyMarkup !== empty || !scroller.querySelector('.empty-state')) scroller.innerHTML = empty;
        emptyMarkup = empty;
        historyRoot = null;
        historyMarkup = null;
        records.clear();
        return;
      }
      if (!historyRoot) {
        scroller.replaceChildren();
        historyRoot = document.createElement('div');
        historyRoot.className = 'conversation-history';
        scroller.appendChild(historyRoot);
        emptyMarkup = null;
      }
      if (history !== historyMarkup) { historyRoot.innerHTML = history; historyMarkup = history; }
      const retained = new Set(messages);
      for (const [message, record] of records) {
        if (!retained.has(message)) { record.node.remove(); records.delete(message); }
      }
      let cursor = historyRoot.nextSibling;
      messages.forEach((message, index) => {
        const markup = messageMarkup(message, index);
        let record = records.get(message);
        if (!record) {
          record = {node:parse(markup), markup};
          records.set(message, record);
        } else if (record.markup !== markup) {
          sync(record.node, parse(markup));
          record.markup = markup;
        }
        if (record.node !== cursor) scroller.insertBefore(record.node, cursor);
        cursor = record.node.nextSibling;
      });
    },
  };
}
