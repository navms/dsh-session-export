/**
 * Unit tests for the Markdown/HTML/JSON renderers, including the escaping
 * invariant that session text can never become live markup.
 *
 * @module dsh-session-export/test/render.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { buildPlan, buildJsonDocument, buildViewDocument, segmentTurns } from '../lib/model.js';
import { escapeHtml, inlineMarkdown, markdownToHtml, safeUrl } from '../lib/markdown.js';
import { fencedBlock, formatBytes, formatTimestamp, labelsFor, prettyJson, renderHtml, renderJson, renderMarkdown } from '../lib/render.js';
import { ALL_SECTIONS, VIEW_SECTIONS, sessionEvents, sessionHeader, XSS_PAYLOAD } from './fixtures.js';

const CONFIG = normalizeConfig(undefined);

/** Build the view document for the synthetic session. */
function view(selectionOverrides = {}) {
  const plan = buildPlan({
    header: sessionHeader(),
    title: '示例会话',
    inheritedEventCount: 0,
    events: sessionEvents(),
    config: CONFIG,
    attachmentsAvailable: true,
  });
  return buildViewDocument({
    plan,
    segments: segmentTurns(sessionEvents()),
    selection: {
      format: 'md',
      turns: null,
      includePreamble: true,
      sections: { ...VIEW_SECTIONS },
      maxToolResultChars: 20000,
      embedImages: true,
      collapseThinking: true,
      language: 'zh',
      ...selectionOverrides,
    },
    generatedAt: 1700000000000,
  });
}

test('escapeHtml neutralizes every markup-active character', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('safeUrl admits only non-executable schemes', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeUrl('#anchor'), '#anchor');
  assert.equal(safeUrl('data:image/png;base64,AA'), 'data:image/png;base64,AA');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('JavaScript:alert(1)'), null);
  assert.equal(safeUrl('/relative/path'), null);
});

test('inlineMarkdown escapes markup and refuses script URLs', () => {
  const html = inlineMarkdown(escapeHtml('`<b>` **bold** *em* ~~gone~~ [x](javascript:alert(1)) [ok](https://e.com)'));
  assert.match(html, /<code>&lt;b&gt;<\/code>/u);
  assert.match(html, /<strong>bold<\/strong>/u);
  assert.match(html, /<em>em<\/em>/u);
  assert.match(html, /<del>gone<\/del>/u);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/u);
  assert.match(html, /<a href="https:\/\/e.com"/u);
  assert.equal(html.includes('href="javascript:'), false);
});

test('markdownToHtml renders the supported subset', () => {
  const html = markdownToHtml([
    '# Title',
    '',
    'paragraph line one',
    'line two',
    '',
    '- a',
    '- b',
    '  - b1',
    '',
    '1. one',
    '2. two',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```js',
    'const a = 1;',
    '```',
  ].join('\n'));
  assert.match(html, /<h1>Title<\/h1>/u);
  assert.match(html, /<p>paragraph line one<br>line two<\/p>/u);
  assert.match(html, /<ul><li>a<\/li><li>b<ul><li>b1<\/li><\/ul><\/li><\/ul>/u);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/u);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/u);
  assert.match(html, /<hr>/u);
  assert.match(html, /<pre class="md-code" data-lang="js"><code>const a = 1;<\/code><\/pre>/u);
});

test('markdownToHtml never emits unescaped session text', () => {
  const html = markdownToHtml(`before ${XSS_PAYLOAD} after\n\n<img src=x onerror=alert(1)>`);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/u);
});

test('markdownToHtml keeps raw HTML-as-text and fenced code intact', () => {
  const html = markdownToHtml('```\n<script>alert(1)</script>\n```');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.equal(html.includes('<script>'), false);
});

test('fencedBlock grows the fence past the payload', () => {
  const fenced = fencedBlock('has ``` inside', 'text');
  assert.match(fenced, /^````text\n/u);
  assert.match(fenced, /\n````$/u);
  assert.equal(fencedBlock('plain').startsWith('```\n'), true);
});

test('prettyJson reformats JSON and passes other text through', () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson('not json'), 'not json');
});

test('formatBytes and formatTimestamp are stable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1234), '1.2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatTimestamp(1001), '1970-01-01 00:00:01 UTC');
  assert.equal(formatTimestamp(0), '-');
  assert.equal(labelsFor('en').user, 'User');
  assert.equal(labelsFor('zh').user, '用户');
});

test('renderMarkdown emits header, turns, thinking, tool traffic, and attachments', () => {
  const { doc } = view();
  const md = renderMarkdown(doc);
  assert.match(md, /^# 示例会话\n/u);
  assert.match(md, /- \*\*会话\*\*: `session-1111-2222`/u);
  assert.match(md, /- \*\*工作目录\*\*: `\/Users\/tester\/workspace`/u);
  assert.match(md, /- \*\*模型\*\*: `alltokens\/DeepSeek-V4-Flash`/u);
  assert.match(md, /<!-- dsh-session-export v1 -->/u);
  assert.match(md, /## 轮次 1 · 1970-01-01 00:00:01 UTC · completed/u);
  assert.match(md, /### 👤 用户/u);
  assert.match(md, /<summary>💭 思考<\/summary>/u);
  assert.match(md, /#### 🛠 工具调用 `read`/u);
  assert.match(md, /```json\n\{\n {2}"file_path": "\/x"\n\}\n```/u);
  assert.match(md, /##### ✅ 结果 · `read`/u);
  assert.match(md, /> 🖼 shot.png · image\/png · 10×20 · 1.2 KB/u);
  assert.match(md, /## 轮次 3 · .* · 进行中/u);
  assert.match(md, new RegExp(XSS_PAYLOAD.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(md.endsWith('\n'), true);
});

test('renderMarkdown reports skipped turns and honors the English chrome', () => {
  const { doc } = view({
    language: 'en',
    turns: [1],
    sections: { ...VIEW_SECTIONS, user: false, thinking: false, assistant: false, toolCalls: false, toolResults: false, images: false, files: false },
  });
  const md = renderMarkdown(doc);
  assert.match(md, /- \*\*Turns\*\*: 1 of 3 selected, 0 rendered, 1 empty turns skipped/u);
  assert.match(md, /> No turn matches the current selection\./u);
});

test('renderMarkdown appends a truncation notice for cut bodies', () => {
  const events = sessionEvents().map((event) => (event.type === 'tool/result'
    ? { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: 'z'.repeat(400) }] } } }
    : event));
  const plan = buildPlan({ header: sessionHeader(), title: null, inheritedEventCount: 0, events, config: CONFIG });
  const { doc } = buildViewDocument({
    plan,
    segments: segmentTurns(events),
    selection: {
      format: 'md',
      turns: [1],
      includePreamble: false,
      sections: { ...VIEW_SECTIONS },
      maxToolResultChars: 100,
      embedImages: true,
      collapseThinking: true,
      language: 'zh',
    },
    generatedAt: 1700000000000,
  });
  const md = renderMarkdown(doc);
  assert.match(md, /已截断 300 字符 \/ truncated 300 chars/u);
});

test('renderHtml is self-contained, escaped, and image-capable', () => {
  const { doc } = view();
  const images = new Map([['sha256:img1', 'data:image/png;base64,AAAA']]);
  const html = renderHtml(doc, { images });
  assert.match(html, /^<!doctype html>\n/u);
  assert.match(html, /<style>/u);
  assert.match(html, /prefers-color-scheme: dark/u);
  assert.match(html, /<title>示例会话<\/title>/u);
  assert.match(html, /<nav class="toc">/u);
  assert.match(html, /<section class="turn" id="turn-1">/u);
  assert.match(html, /<figure class="att att-image"><img src="data:image\/png;base64,AAAA"/u);
  assert.equal(html.includes('</body>'), true);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/u);
  assert.equal(html.includes(XSS_PAYLOAD), false);
});

test('renderHtml expands thinking blocks when collapseThinking is off', () => {
  const { doc } = view({ collapseThinking: false });
  const html = renderHtml(doc);
  assert.match(html, /<details class="ev ev-thinking" open/u);
  const { doc: collapsed } = view();
  assert.equal(/<details class="ev ev-thinking" open/u.test(renderHtml(collapsed)), false);
});

test('renderHtml falls back to placeholders without an image lookup', () => {
  const { doc } = view();
  const html = renderHtml(doc);
  assert.match(html, /<div class="att att-image">/u);
  assert.equal(html.includes('data:image/png;base64'), false);
});

test('renderJson pretty-prints the raw-event document', () => {
  const plan = buildPlan({ header: sessionHeader(), title: null, inheritedEventCount: 0, events: sessionEvents(), config: CONFIG });
  const doc = buildJsonDocument({
    plan,
    segments: segmentTurns(sessionEvents()),
    selection: {
      format: 'json',
      turns: [1],
      includePreamble: false,
      sections: { ...ALL_SECTIONS, usage: true },
      maxToolResultChars: 20000,
      embedImages: true,
      collapseThinking: true,
      language: 'zh',
    },
    generatedAt: 1700000000000,
  });
  const text = renderJson(doc);
  assert.equal(text.endsWith('\n'), true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'dsh-session-transcript');
  assert.deepEqual(parsed.turns.map((turn) => turn.turn), [1]);
  assert.equal(parsed.preamble, null);
  const assistant = parsed.turns[0].events.find((event) => event.type === 'assistant/message');
  assert.deepEqual(assistant.data.message.content.map((block) => block.type), ['reasoning', 'text', 'tool-call']);
  assert.equal(assistant.data.usage.inputTokens, 100);
});
