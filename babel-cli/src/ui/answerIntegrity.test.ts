import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownAccumulator } from './markdownAccumulator.js';
import { renderMarkdown } from './highlight.js';
import { stripAnsi } from './theme.js';
import { createVirtualCellGrid } from './observe/virtualCellGrid.js';
import { measureDisplayWidth } from './textLayout.js';

const source = '# Response\n\nA **readable** answer using `code` and *emphasis*.\n\n1. **First rule**: inspect the OpenRouter response before acting.\n2. **Second rule**: preserve every distinct sentence.\n\nLast sentence without a newline.';

for (const width of [32, 80, 140]) {
  for (const chunkSize of [1, 7, 37, source.length]) {
    test(`committed answer replay: width=${width}, chunks=${chunkSize}`, () => {
      const acc = new MarkdownAccumulator();
      acc.setPaintPolicy('stable');
      acc.setTerminalWidth(width);
      const render = (s: string) => renderMarkdown(s, width);
      let writes = '';
      for (let i = 0; i < source.length; i += chunkSize) writes += acc.feed(source.slice(i, i + chunkSize), render);
      writes += acc.finalize(render);
      assert.equal(acc.finalize(render), '', 'settling twice cannot reprint');
      assert.doesNotMatch(writes, /\r|\x1b\[[\d;]*[AJK]/, 'committed text must never be erased or repositioned');
      const grid = createVirtualCellGrid(width, 100);
      grid.apply(writes);
      const cells = grid.snapshot().lines.join('\n');
      const normalized = cells.replace(/\s+/g, ' ');
      for (const phrase of ['Response', 'readable', 'First rule', 'Second rule', 'Last sentence']) {
        assert.equal(normalized.split(phrase).length - 1, 1, `${phrase} occurs once`);
      }
      assert.doesNotMatch(cells, /\*\*|`|\*emphasis\*/);
      assert.match(normalized, /1\. First rule.*2\. Second rule/);
      assert.equal(acc.totalBytes, Buffer.byteLength(source));
      assert.equal(stripAnsi(acc.getRenderedText()), stripAnsi(writes));
    });
  }
}

test('fallback resize never replays committed text and holds unfinished fences', () => {
  const acc = new MarkdownAccumulator();
  acc.setPaintPolicy('stable');
  const render = (s: string) => renderMarkdown(s, 40);
  const first = acc.feed('Committed paragraph.\n\n```text\ncode with\n\na blank line', render);
  assert.match(first, /Committed paragraph/);
  assert.doesNotMatch(first, /code with/);
  assert.equal(acc.reflow(20, render), '');
  const rest = acc.feed('\n```\n\nFinal 👨‍👩‍👧‍👦 e\u0301 界.', render) + acc.finalize(render);
  assert.doesNotMatch(rest, /Committed paragraph/);
  assert.match(rest, /code with/);
  assert.match(rest, /👨‍👩‍👧‍👦 e\u0301 界/);
});

test('nested inline tokens in lists render and continuation hangs under content', () => {
  const text = stripAnsi(renderMarkdown('1. **Bold label** with *emphasis* and `code` followed by a longer explanation.\n   - nested **label**\n2. Last item.', 30));
  assert.doesNotMatch(text, /\*|`/);
  assert.match(text, /1\. Bold label/);
  assert.match(text, /\n     /);
  assert.equal(text.split('nested label').length - 1, 1);
});

test('late reference definitions are resolved before their prose is committed', () => {
  const acc = new MarkdownAccumulator();
  acc.setPaintPolicy('stable');
  let text = acc.feed('Read [the guide][manual].\n\nMore prose.\n', renderMarkdown);
  assert.equal(text, '');
  text += acc.feed('\n[manual]: https://example.com/guide\n', renderMarkdown);
  text += acc.finalize(renderMarkdown);
  assert.match(stripAnsi(text), /the guide.*https:\/\/example.com\/guide/);
  assert.doesNotMatch(text, /\[manual\]/);
});

test('loose list text remains in source order around a nested list', () => {
  const text = stripAnsi(renderMarkdown('1. Before the nested list.\n   - Nested item.\n\n   After the nested list.\n2. Final item.', 80));
  assert.match(text, /Before the nested list\.[\s\S]*Nested item\.[\s\S]*After the nested list\.[\s\S]*2\. Final item\./);
});

test('shortcut references retain their late-defined destination', () => {
  const acc = new MarkdownAccumulator();
  acc.setPaintPolicy('stable');
  const early = acc.feed('Read [manual].\n\nNext paragraph.\n', renderMarkdown);
  assert.equal(early, '');
  acc.feed('\n[manual]: https://example.com/reference\n', renderMarkdown);
  const grid = createVirtualCellGrid(80, 40);
  grid.apply(acc.finalize(renderMarkdown));
  const text = grid.snapshot().lines.join('\n').replace(/\s+/g, ' ');
  assert.match(text, /manual \(https:\/\/example.com\/reference\)/);
  assert.doesNotMatch(text, /\[manual\]/);
});

for (const chunkSize of [1, 7, 999]) {
  test(`CRLF block boundaries preserve fenced code, chunks=${chunkSize}`, () => {
    const raw = '```text\r\nAlpha\r\nBeta\r\nGamma\r\nDelta\r\nEpsilon\r\n```\r\n\r\nFinal paragraph.\r\n';
    const acc = new MarkdownAccumulator();
    acc.setPaintPolicy('stable');
    const renderedSources: string[] = [];
    const render = (text: string) => { renderedSources.push(text); return renderMarkdown(text); };
    let output = '';
    for (let i = 0; i < raw.length; i += chunkSize) output += acc.feed(raw.slice(i, i + chunkSize), render);
    output += acc.finalize(render);
    assert.match(renderedSources[0] ?? '', /Epsilon\r\n```/, 'the first emitted code block must include its closing fence');
    const grid = createVirtualCellGrid(80, 40);
    grid.apply(output);
    const text = grid.snapshot().lines.join('\n').replace(/\s+/g, ' ');
    assert.match(text, /Alpha.*Beta.*Gamma.*Delta.*Epsilon.*Final paragraph\./);
    assert.doesNotMatch(text, /```/);
    assert.equal(acc.totalBytes, Buffer.byteLength(raw));
  });
}

test('shortcut references adjacent to words wait for late definitions', () => {
  const acc = new MarkdownAccumulator();
  acc.setPaintPolicy('stable');
  const first = acc.feed('Read[manual].\n\nNext paragraph.\n', renderMarkdown);
  assert.equal(first, '');
  acc.feed('\n[manual]: https://example.com/guide\n', renderMarkdown);
  const grid = createVirtualCellGrid(80, 40);
  grid.apply(acc.finalize(renderMarkdown));
  assert.match(grid.snapshot().lines.join('\n'), /Readmanual \(https:\/\/example.com\/guide\)/);
});

test('nested quotations reserve their prefix and honor an explicit narrow width', () => {
  const rendered = stripAnsi(renderMarkdown('> A quotation with OpenRouter and words that need hanging indentation.\n>\n> > A nested quotation with another complete sentence.', 28));
  assert.match(rendered, /OpenRouter/);
  for (const line of rendered.split('\n')) {
    assert.ok(measureDisplayWidth(line) < 28, line);
    assert.match(line, /^  │ /);
  }
});

test('task list checkboxes appear once on their item line', () => {
  const text = stripAnsi(renderMarkdown('- [x] Done\n- [ ] Pending', 60));
  assert.equal(text.split('[x]').length - 1, 1, text);
  assert.equal(text.split('[ ]').length - 1, 1, text);
  assert.match(text, /\[x\] Done/);
  assert.match(text, /\[ \] Pending/);
});

test('multiline reference labels retain their late destination', () => {
  const acc = new MarkdownAccumulator(); acc.setPaintPolicy('stable');
  assert.equal(acc.feed('Read [manual\npage].\n\nNext paragraph.\n', renderMarkdown), '');
  acc.feed('\n[manual page]: https://example.com/guide\n', renderMarkdown);
  const grid = createVirtualCellGrid(80, 40); grid.apply(acc.finalize(renderMarkdown));
  assert.match(grid.snapshot().lines.join('\n').replace(/\s+/g, ' '), /manual page \(https:\/\/example.com\/guide\)/);
});

for (const width of [28, 80, 140]) {
  test(`table cells retain complete text within explicit width=${width}`, () => {
    const table = '| Key | Description |\n| --- | --- |\n| unique-key | This complete cell contains OpenRouter and a unique-final-word that must survive layout. |';
    const text = stripAnsi(renderMarkdown(table, width));
    for (const line of text.split('\n')) assert.ok(measureDisplayWidth(line) < width, line);
    const cells = text.replace(/[│\s]+/g, ' ');
    assert.match(cells, /unique-final-word/);
    assert.match(cells, /must survive layout\./);
    assert.match(cells, /OpenRouter/);
  });
}

test('header-only tables keep their labels and extremely narrow multirow tables do not throw', () => {
  for (const width of [28, 80]) {
    const text = stripAnsi(renderMarkdown('| First header | Second header |\n| --- | --- |', width)).replace(/\s+/g, ' ');
    assert.match(text, /First header/);
    assert.match(text, /Second header/);
  }
  assert.doesNotThrow(() => renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |', 1));
});
