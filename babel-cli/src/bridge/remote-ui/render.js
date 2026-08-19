(function (root) {
  function appendSafeText(target, text) {
    target.appendChild(document.createTextNode(text));
  }

  function appendTranscriptEvent(target, event) {
    const row = document.createElement('div');
    row.className = 'event';
    row.setAttribute('data-type', event.type || 'event');
    const label = document.createElement('strong');
    appendSafeText(label, event.type || 'event');
    row.appendChild(label);
    const body = event.text || event.error || [event.tool, event.target].filter(Boolean).join(' ');
    if (body) {
      const pre = document.createElement('pre');
      appendSafeText(pre, body);
      row.appendChild(pre);
    }
    target.appendChild(row);
  }

  function setText(el, text) {
    el.textContent = text;
  }

  root.BabelRemoteRender = {
    appendSafeText: appendSafeText,
    appendTranscriptEvent: appendTranscriptEvent,
    setText: setText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
