/**
 * Minimal, dependency-free Markdown subset renderer used by the HTML export.
 *
 * Two invariants drive the design:
 *
 * 1. Session text is untrusted. The source is HTML-escaped first, and every
 *    later transformation only injects markup this module generated itself,
 *    so no character from a session log can ever become live markup.
 * 2. Unknown syntax degrades to escaped plain text rather than disappearing,
 *    so an export never silently drops content it failed to parse.
 *
 * Supported: ATX headings, fenced code blocks, blockquotes, ordered and
 * unordered lists (nested by indentation), thematic breaks, paragraphs,
 * inline code, emphasis, strong, strikethrough, links, images, and bare
 * autolinks. Markdown features outside this subset (tables, footnotes, math,
 * raw HTML) render as escaped text.
 *
 * @module dsh-session-export/markdown
 */

/** Placeholder delimiter for extracted inline-code spans. */
const CODE_SENTINEL = '\u0001dsh-code-';

/**
 * Escape text for use in HTML text and double-quoted attribute positions.
 * @param value - untrusted source text.
 * @returns the escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * Admit a URL destination only for schemes that cannot execute script.
 * @param url - the already-escaped destination.
 * @returns the destination, or `null` when it must degrade to text.
 */
export function safeUrl(url) {
  const value = String(url);
  if (value.startsWith('#')) return value;
  if (/^https?:\/\//iu.test(value)) return value;
  if (/^mailto:/iu.test(value)) return value;
  if (/^data:image\//iu.test(value)) return value;
  return null;
}

/** Heading levels the export's own skeleton owns: h1 title, h2 turn, h3 section. */
export const CONTENT_HEADING_OFFSET = 3;

/** Markers that mean the previous line is not a setext title. */
const SETEXT_BLOCKERS = /^ {0,3}(?:[-+*|>#]|\d{1,9}[.)]|`{3,}|~{3,})/u;

/**
 * Shift the headings inside rendered message content down the hierarchy.
 *
 * Model replies legitimately contain Markdown headings, but they must not join
 * the export's own outline: a `#` in a reply would otherwise become a second
 * document title and a `##` would sit beside `## 轮次 N`. Shifting keeps the
 * content's own relative order while leaving the transcript skeleton
 * authoritative. ATX and setext headings are both handled.
 * @param value - rendered message text.
 * @param offset - levels to shift by.
 * @returns the text with demoted headings.
 */
export function demoteHeadings(value, offset = CONTENT_HEADING_OFFSET) {
  const out = [];
  for (const line of String(value ?? '').split('\n')) {
    const atx = /^( {0,3})(#{1,6})(\s+)(.*)$/u.exec(line);
    if (atx !== null) {
      out.push(`${atx[1]}${'#'.repeat(Math.min(6, atx[2].length + offset))}${atx[3]}${atx[4]}`);
      continue;
    }
    const setext = /^ {0,3}(=+|-+)\s*$/u.exec(line);
    const previous = out.length > 0 ? out[out.length - 1] : '';
    if (setext !== null && previous.trim().length > 0 && !SETEXT_BLOCKERS.test(previous)) {
      const base = setext[1].startsWith('=') ? 1 : 2;
      out[out.length - 1] = `${'#'.repeat(Math.min(6, base + offset))} ${previous.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Apply inline Markdown transformations to already-escaped single-line text.
 * @param escaped - escaped source text.
 * @returns the HTML fragment.
 */
export function inlineMarkdown(escaped) {
  const codes = [];
  let text = String(escaped);
  text = text.replace(/`([^`\n]+)`/gu, (_match, inner) => {
    codes.push(inner);
    return `${CODE_SENTINEL}${codes.length - 1}\u0001`;
  });
  text = text.replace(/!\[([^\]]*)\]\(([^()\s]+)[^)]*\)/gu, (match, alt, url) => {
    const safe = safeUrl(url);
    return safe === null ? match : `<img src="${safe}" alt="${alt}" class="md-image">`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^()\s]+)[^)]*\)/gu, (match, label, url) => {
    const safe = safeUrl(url);
    return safe === null ? match : `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<>()]+)/gu,
    (_match, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+)~~/gu, '<del>$1</del>');
  return text.replace(new RegExp(`${CODE_SENTINEL}(\\d+)\\u0001`, 'gu'), (_match, index) => `<code>${codes[Number(index)]}</code>`);
}

/**
 * Expand tabs and count leading indentation width.
 * @param line - one source line.
 * @returns the line with tabs expanded.
 */
function expandTabs(line) {
  return line.replace(/\t/gu, '    ');
}

/**
 * Escape, then render, a fenced code block body.
 * @param lines - the fence body lines.
 * @param language - the fence info string's first token.
 * @returns the `<pre>` element.
 */
function codeBlockHtml(lines, language) {
  const languageAttribute = language.length > 0 ? ` data-lang="${escapeHtml(language)}"` : '';
  return `<pre class="md-code"${languageAttribute}><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
}

/**
 * Render a flat, indentation-annotated list item sequence.
 * @param items - items in source order, each `{ indent, ordered, text }`.
 * @returns the list HTML.
 */
function listHtml(items) {
  let html = '';
  const stack = [];
  for (const item of items) {
    while (stack.length > 0 && stack[stack.length - 1].indent > item.indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    const tag = item.ordered ? 'ol' : 'ul';
    if (top === undefined || item.indent > top.indent) {
      html += `<${tag}><li>${inlineMarkdown(item.text)}`;
      stack.push({ indent: item.indent, tag });
      continue;
    }
    if (top.tag === tag) {
      html += `</li><li>${inlineMarkdown(item.text)}`;
      continue;
    }
    html += `</li></${top.tag}>`;
    stack.pop();
    html += `<${tag}><li>${inlineMarkdown(item.text)}`;
    stack.push({ indent: item.indent, tag });
  }
  while (stack.length > 0) html += `</li></${stack.pop().tag}>`;
  return html;
}

/** Matches one list item: indentation, bullet or ordered marker, and text. */
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u;

/** Matches an ATX heading. */
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;

/** Matches a thematic break. */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

/** Matches a blockquote line. */
const BLOCKQUOTE = /^ {0,3}>\s?(.*)$/u;

/** Matches a fenced code opener. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/u;

/**
 * Render a Markdown subset document as HTML.
 * @param source - untrusted Markdown source.
 * @param options - optional `headingOffset` shifting every heading down the hierarchy.
 * @returns the rendered HTML fragment.
 */
export function markdownToHtml(source, options = {}) {
  const baseline = Number.isFinite(options.headingOffset) ? options.headingOffset : 0;
  const lines = expandTabs(String(source ?? '').replace(/\r\n?/gu, '\n')).split('\n');
  const out = [];
  let paragraph = [];
  let index = 0;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map((line) => inlineMarkdown(escapeHtml(line))).join('<br>')}</p>`);
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    const fence = CODE_FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const marker = fence[1][0];
      const length = fence[1].length;
      const body = [];
      index += 1;
      const closer = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${length},}\\s*$`, 'u');
      while (index < lines.length && !closer.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(codeBlockHtml(body, fence[2] ?? ''));
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = Math.min(6, Math.max(1, heading[1].length + baseline));
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
      index += 1;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      out.push('<hr>');
      index += 1;
      continue;
    }
    const quote = BLOCKQUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      const body = [];
      while (index < lines.length) {
        const next = BLOCKQUOTE.exec(lines[index]);
        if (next === null) break;
        body.push(next[1]);
        index += 1;
      }
      out.push(`<blockquote>${markdownToHtml(body.join('\n'), options)}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const candidate = LIST_ITEM.exec(lines[index]);
        if (candidate === null) {
          if (lines[index].trim() === '') break;
          if (items.length > 0 && /^\s{2,}\S/u.test(lines[index])) {
            items[items.length - 1].text += `\n${lines[index].trim()}`;
            index += 1;
            continue;
          }
          break;
        }
        items.push({
          indent: candidate[1].length,
          ordered: /^\d/u.test(candidate[2]),
          text: candidate[3],
        });
        index += 1;
      }
      out.push(listHtml(items));
      continue;
    }
    const underline = index + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/u.exec(lines[index + 1]) : null;
    if (underline !== null && paragraph.length === 0 && line.trim().length > 0) {
      // Setext heading: the following `===`/`---` line turns this line into one.
      flushParagraph();
      const base = underline[1].startsWith('=') ? 1 : 2;
      const level = Math.min(6, Math.max(1, base + baseline));
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(line.trim()))}</h${level}>`);
      index += 2;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return out.join('\n');
}
