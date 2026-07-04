/**
 * Luigi Codes — minimal Markdown → HTML for the chat webview.
 *
 * SINGLE SOURCE for chat rendering. chatPanel.ts injects these functions'
 * source into the webview via Function.prototype.toString(), and the test
 * suite imports them directly — so the code that renders in the panel is the
 * exact code under test. They MUST stay self-contained: no module-scope
 * references, no DOM, only each other and string built-ins, or the injected
 * copy would reference symbols that don't exist in the webview.
 */

/** Escape the five characters that could break out of text content. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inline spans. Inline `code` is parsed FIRST and its content is emitted
 * verbatim; links and **bold** are applied only to text OUTSIDE code spans.
 * Applying them globally would corrupt code such as `x**2 + y**2` (bolding the
 * run between the `**`) or `[a](b)` shown literally in a code sample.
 */
export function renderInline(s: string): string {
  const codeSpan = /`([^`]+)`/g;
  const format = (seg: string): string =>
    seg
      // [text](url) → anchor, but only for safe schemes; the URL's quotes are
      // escaped so it cannot break out of the href attribute. A function
      // replacer keeps `$` sequences in the URL literal.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, url: string) =>
        /^(https?:\/\/|mailto:)/i.test(url)
          ? '<a href="' + url.replace(/"/g, '&quot;') + '">' + text + '</a>'
          : whole
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = codeSpan.exec(s)) !== null) {
    out += format(s.slice(last, match.index)) + '<code class="inline">' + match[1] + '</code>';
    last = codeSpan.lastIndex;
  }
  return out + format(s.slice(last));
}

/**
 * Block-level render: fenced code, headings (#..###), unordered and ordered
 * lists, paragraphs. Odd split segments are fenced code and are NOT inline-
 * parsed, so their content stays literal.
 */
export function renderMarkdown(text: string): string {
  const parts = text.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const block = parts[i];
      const nl = block.indexOf('\n');
      const lang = nl > -1 ? block.slice(0, nl).trim() : '';
      const code = nl > -1 ? block.slice(nl + 1) : block;
      html +=
        '<div class="codeblock"><div class="bar"><span>' + escapeHtml(lang || 'code') +
        '</span><button class="copy">Copy</button></div><pre><code>' +
        escapeHtml(code.replace(/\n$/, '')) + '</code></pre></div>';
    } else {
      const lines = escapeHtml(parts[i]).split('\n');
      const out: string[] = [];
      let listTag: string | null = null;
      const closeList = (): void => {
        if (listTag) {
          out.push('</' + listTag + '>');
          listTag = null;
        }
      };
      const openList = (tag: string): void => {
        if (listTag !== tag) {
          closeList();
          out.push('<' + tag + '>');
          listTag = tag;
        }
      };
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (heading) {
          closeList();
          const level = heading[1].length + 1;
          out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        } else if (bullet) {
          openList('ul');
          out.push('<li>' + renderInline(bullet[1]) + '</li>');
        } else if (ordered) {
          openList('ol');
          out.push('<li>' + renderInline(ordered[1]) + '</li>');
        } else if (line.trim() === '') {
          closeList();
        } else {
          closeList();
          out.push('<p>' + renderInline(line) + '</p>');
        }
      }
      closeList();
      html += out.join('');
    }
  }
  return html;
}
