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

/**
 * Escape the three characters that matter in HTML *text* content (& < >).
 * NOTE: quotes are NOT escaped, so when interpolating into an attribute value
 * (e.g. an href) you must escape `"` yourself (renderInline does).
 * INPUT CONTRACT: renderInline assumes its input is ALREADY escaped by this
 * function; never call it on raw model text or you reintroduce XSS.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inline spans. Inline `code` is parsed FIRST and its content is emitted
 * verbatim; links and **bold** are applied only to text OUTSIDE code spans.
 * Links are tokenized BEFORE bold so a `**` inside a link URL can never be
 * turned into <strong> tags (which would corrupt the href) — the same reason
 * code spans are protected from bolding `x**2 + y**2`.
 */
export function renderInline(s: string): string {
  const codeSpan = /`([^`]+)`/g;
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const bold = (seg: string): string => seg.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const format = (seg: string): string => {
    // Tokenize links: emit each <a> with a verbatim (quote-escaped) href so the
    // bold pass can only ever touch text, never the URL. rel="noreferrer" keeps
    // a token-bearing page URL out of the Referer when a link is clicked.
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(seg)) !== null) {
      out += bold(seg.slice(last, m.index));
      const whole = m[0];
      const text = m[1];
      const url = m[2];
      out += /^(https?:\/\/|mailto:)/i.test(url)
        ? '<a href="' + url.replace(/"/g, '&quot;') + '" rel="noreferrer noopener">' + bold(text) + '</a>'
        : bold(whole);
      last = linkRe.lastIndex;
    }
    return out + bold(seg.slice(last));
  };
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
