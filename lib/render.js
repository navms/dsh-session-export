/**
 * Markdown, HTML, and JSON serializers over the view/JSON export documents.
 *
 * The Markdown and HTML renderers consume the same format-agnostic block list
 * produced by `model.js`, so the two formats can never disagree about which
 * content belongs to a turn. Both are pure: attachment bytes are resolved by
 * the host route *before* rendering and arrive as a plain `id -> data URI`
 * lookup.
 *
 * @module dsh-session-export/render
 */

import { PLUGIN_NAME, PLUGIN_VERSION } from './config.js';
import { truncationNotice } from './model.js';
import { escapeHtml, markdownToHtml } from './markdown.js';

/** Per-language chrome labels shared by the Markdown and HTML renderers. */
const LABELS = {
  zh: {
    session: '会话',
    created: '创建时间',
    workspace: '工作目录',
    model: '模型',
    turns: '轮次',
    turnsValue: (selected, total, rendered, skipped) =>
      `选中 ${selected} / 共 ${total}，输出 ${rendered}${skipped > 0 ? `，跳过空轮次 ${skipped}` : ''}`,
    exported: '导出时间',
    generator: '生成器',
    preamble: '会话前导',
    turn: '轮次',
    open: '进行中',
    user: '用户',
    context: '上下文',
    system: '系统提示',
    developer: '开发者消息',
    thinking: '思考',
    assistant: '助手',
    toolCall: '工具调用',
    toolResult: '工具结果',
    result: '结果',
    failed: '失败',
    interrupted: '该回合被中断',
    attempt: '未完成的模型尝试',
    usage: 'Token 用量',
    stream: '原始流记录',
    other: '其他事件',
    image: '图片',
    file: '文件',
    truncated: '（已截断）',
    noTurns: '没有匹配所选条件的轮次。',
    contents: '目录',
  },
  en: {
    session: 'Session',
    created: 'Created',
    workspace: 'Workspace',
    model: 'Model',
    turns: 'Turns',
    turnsValue: (selected, total, rendered, skipped) =>
      `${selected} of ${total} selected, ${rendered} rendered${skipped > 0 ? `, ${skipped} empty turns skipped` : ''}`,
    exported: 'Exported',
    generator: 'Generator',
    preamble: 'Session preamble',
    turn: 'Turn',
    open: 'in progress',
    user: 'User',
    context: 'Context',
    system: 'System prompt',
    developer: 'Developer message',
    thinking: 'Thinking',
    assistant: 'Assistant',
    toolCall: 'Tool call',
    toolResult: 'Tool result',
    result: 'Result',
    failed: 'failed',
    interrupted: 'This turn was interrupted',
    attempt: 'Incomplete model attempt',
    usage: 'Token usage',
    stream: 'Raw stream records',
    other: 'Other event',
    image: 'Image',
    file: 'File',
    truncated: 'truncated',
    noTurns: 'No turn matches the current selection.',
    contents: 'Contents',
  },
};

/**
 * Resolve the chrome label table for one language.
 * @param language - `zh` or `en`.
 * @returns the label table.
 */
export function labelsFor(language) {
  return language === 'en' ? LABELS.en : LABELS.zh;
}

/**
 * Compose a Markdown code fence that cannot be closed by the payload.
 * @param text - fence body.
 * @param language - optional info string.
 * @returns the fenced block without a trailing newline.
 */
export function fencedBlock(text, language = '') {
  const longest = (String(text).match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * Indent a body so it can sit inside a Markdown `<details>` element.
 * @param text - the body.
 * @returns the indented body.
 */
function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join('\n');
}

/**
 * Wrap a body in a Markdown collapsible section.
 * @param summary - the visible summary line.
 * @param body - the body.
 * @returns the details block.
 */
export function detailsBlock(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/**
 * Pretty-print a raw tool-argument string when it is valid JSON.
 * @param raw - the raw argument string.
 * @returns the pretty form, or the raw string.
 */
export function prettyJson(raw) {
  const text = String(raw ?? '');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Format a byte count for humans.
 * @param bytes - the byte count.
 * @returns the formatted size.
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format an epoch-millisecond timestamp deterministically in UTC.
 * @param time - epoch milliseconds.
 * @returns an ISO-like UTC timestamp, or `-`.
 */
export function formatTimestamp(time) {
  const value = Number(time);
  if (!Number.isFinite(value) || value <= 0) return '-';
  return `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * Describe one attachment as a Markdown blockquote line.
 * @param label - `image` or `file` labels.
 * @param ref - the normalized reference.
 * @returns the Markdown line.
 */
function attachmentLine(label, ref) {
  if (label === 'image') {
    const name = ref.name.length > 0 ? ref.name : 'image';
    const size = ref.width > 0 && ref.height > 0 ? `${ref.width}×${ref.height} · ` : '';
    return `> 🖼 ${name} · ${ref.mediaType} · ${size}${formatBytes(ref.bytes)}`;
  }
  const name = ref.name.length > 0 ? ref.name : 'file';
  return `> 📎 ${name} · ${formatBytes(ref.bytes)}`;
}

/**
 * Render one attachment descriptor for the HTML export.
 * @param label - `image` or `file`.
 * @param ref - the normalized reference.
 * @param dataUri - resolved bytes, when embedding is enabled and available.
 * @returns the HTML fragment.
 */
function attachmentHtml(label, ref, dataUri) {
  const name = escapeHtml(ref.name.length > 0 ? ref.name : label);
  const meta = label === 'image'
    ? `${escapeHtml(ref.mediaType)} · ${ref.width > 0 ? `${ref.width}×${ref.height} · ` : ''}${formatBytes(ref.bytes)}`
    : formatBytes(ref.bytes);
  if (label === 'image' && typeof dataUri === 'string') {
    return `<figure class="att att-image"><img src="${dataUri}" alt="${name}" loading="lazy"><figcaption>${name} · ${meta}</figcaption></figure>`;
  }
  return `<div class="att att-${label}"><span class="att-icon">${label === 'image' ? '🖼' : '📎'}</span><span class="att-name">${name}</span><span class="att-meta">${meta}</span></div>`;
}

/** One block's own section label and emoji. */
function headingOf(block, t) {
  switch (block.kind) {
    case 'user':
      return `👤 ${t.user}`;
    case 'system':
      return `⚙️ ${t.system}`;
    case 'developer':
    case 'context':
      return `🧩 ${t.context}`;
    case 'assistant':
      return `🤖 ${t.assistant}`;
    case 'attempt':
      return `⚠️ ${t.attempt}`;
    case 'stream':
      return `🔁 ${t.stream}`;
    default:
      return `📦 ${t.other}`;
  }
}

/**
 * Render one block as Markdown.
 * @param block - one view block.
 * @param t - the label table.
 * @returns the Markdown fragment, or an empty string when the block renders nothing.
 */
export function blockToMarkdown(block, t) {
  const parts = [];
  const attachmentLines = [
    ...(block.images ?? []).map((ref) => attachmentLine('image', ref)),
    ...(block.files ?? []).map((ref) => attachmentLine('file', ref)),
  ];
  switch (block.kind) {
    case 'user':
    case 'context':
    case 'assistant': {
      parts.push(`### ${headingOf(block, t)}`);
      if (block.kind === 'assistant' && block.interrupted === true) parts.push(`> ⚠️ ${t.interrupted}`);
      if (block.text.length > 0) parts.push(block.text);
      if (attachmentLines.length > 0) parts.push(attachmentLines.join('\n'));
      break;
    }
    case 'thinking':
      parts.push(detailsBlock(`💭 ${t.thinking}`, indent(block.text)));
      break;
    case 'tool-call':
      parts.push(`#### 🛠 ${t.toolCall} \`${block.name}\`${block.callId !== null ? ` · \`${block.callId}\`` : ''}`);
      parts.push(fencedBlock(prettyJson(block.args), 'json'));
      break;
    case 'tool-result': {
      const status = block.isError ? `❌ ${t.failed}` : `✅ ${t.result}`;
      parts.push(`##### ${status}${block.name !== null ? ` · \`${block.name}\`` : ''}${block.callId !== null ? ` · \`${block.callId}\`` : ''}`);
      if (block.errorText !== null) parts.push(`> ${block.errorText}`);
      if (block.text.length > 0) parts.push(fencedBlock(block.text, 'text'));
      if (block.truncated === true) parts.push(`> ${truncationNotice(block.removedChars)}`);
      if (attachmentLines.length > 0) parts.push(attachmentLines.join('\n'));
      break;
    }
    case 'attempt':
      parts.push(`### ${headingOf(block, t)}`);
      parts.push(block.text.length > 0 ? fencedBlock(block.text, 'text') : `> (${t.attempt})`);
      break;
    case 'usage': {
      const usage = block.usage;
      const total = usage.totalTokens === null ? usage.inputTokens + usage.outputTokens : usage.totalTokens;
      parts.push(`> 📊 ${t.usage} · in ${usage.inputTokens} · out ${usage.outputTokens} · total ${total}`);
      break;
    }
    case 'stream':
      parts.push(`#### ${headingOf(block, t)}`);
      parts.push(fencedBlock(block.text, 'text'));
      break;
    case 'marker':
      parts.push(`> ⏱ ${block.text}`);
      break;
    case 'other': {
      parts.push(
        detailsBlock(
          `📦 ${t.other} \`${block.type}\` · #${block.seq}`,
          fencedBlock(block.text, 'json') + (block.truncated === true ? `\n\n> ${truncationNotice(block.removedChars)}` : ''),
        ),
      );
      break;
    }
    default:
      return '';
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Render one block as HTML.
 * @param block - one view block.
 * @param t - the label table.
 * @param settings - `{ images, collapseThinking }` render settings.
 * @returns the HTML fragment, or an empty string when the block renders nothing.
 */
export function blockToHtml(block, t, settings) {
  const images = settings.images;
  const attributes = `data-seq="${block.seq}" data-type="${escapeHtml(block.type)}"`;
  const markdown = (text) => `<div class="md">${markdownToHtml(text)}</div>`;
  const resolved = (refs, label) => (refs ?? []).map((ref) => attachmentHtml(label, ref, images.get(ref.attachmentId))).join('');
  switch (block.kind) {
    case 'user':
    case 'context':
    case 'assistant': {
      const body = [
        block.text.length > 0 ? markdown(block.text) : '',
        resolved(block.images, 'image'),
        resolved(block.files, 'file'),
      ].join('');
      const interrupted = block.kind === 'assistant' && block.interrupted === true ? `<p class="note">⚠️ ${escapeHtml(t.interrupted)}</p>` : '';
      return `<section class="ev ev-${block.kind}" ${attributes}><h3>${escapeHtml(headingOf(block, t))}</h3>${interrupted}${body}</section>`;
    }
    case 'thinking': {
      const open = settings.collapseThinking === false ? ' open' : '';
      return `<details class="ev ev-thinking"${open} ${attributes}><summary>💭 ${escapeHtml(t.thinking)}</summary>${markdown(block.text)}</details>`;
    }
    case 'tool-call':
      return `<section class="ev ev-tool-call" ${attributes}><h4>🛠 ${escapeHtml(`${t.toolCall} ${block.name}`)}${block.callId !== null ? ` <code>${escapeHtml(block.callId)}</code>` : ''}</h4><pre class="md-code" data-lang="json"><code>${escapeHtml(prettyJson(block.args))}</code></pre></section>`;
    case 'tool-result': {
      const status = block.isError ? `❌ ${t.failed}` : `✅ ${t.result}`;
      const title = `${status}${block.name !== null ? ` ${block.name}` : ''}${block.callId !== null ? ` ${block.callId}` : ''}`;
      return `<section class="ev ev-tool-result${block.isError ? ' is-error' : ''}" ${attributes}><h5>${escapeHtml(title)}</h5>${block.errorText !== null ? `<p class="note">${escapeHtml(block.errorText)}</p>` : ''}${block.text.length > 0 ? `<pre class="md-code" data-lang="text"><code>${escapeHtml(block.text)}</code></pre>` : ''}${block.truncated === true ? `<p class="note">${escapeHtml(truncationNotice(block.removedChars))}</p>` : ''}${resolved(block.images, 'image')}${resolved(block.files, 'file')}</section>`;
    }
    case 'attempt':
      return `<section class="ev ev-attempt" ${attributes}><h3>${escapeHtml(headingOf(block, t))}</h3>${block.text.length > 0 ? `<pre class="md-code" data-lang="text"><code>${escapeHtml(block.text)}</code></pre>` : `<p class="note">${escapeHtml(t.attempt)}</p>`}</section>`;
    case 'usage': {
      const usage = block.usage;
      const total = usage.totalTokens === null ? usage.inputTokens + usage.outputTokens : usage.totalTokens;
      return `<p class="ev ev-usage" ${attributes}>📊 ${escapeHtml(t.usage)} · in ${usage.inputTokens} · out ${usage.outputTokens} · total ${total}</p>`;
    }
    case 'stream':
      return `<section class="ev ev-stream" ${attributes}><h4>🔁 ${escapeHtml(t.stream)}</h4><pre class="md-code" data-lang="text"><code>${escapeHtml(block.text)}</code></pre></section>`;
    case 'marker':
      return `<p class="ev ev-marker" ${attributes}>⏱ ${escapeHtml(block.text)}</p>`;
    case 'other':
      return `<details class="ev ev-other" ${attributes}><summary>📦 ${escapeHtml(`${t.other} ${block.type} #${block.seq}`)}</summary><pre class="md-code" data-lang="json"><code>${escapeHtml(block.text)}</code></pre>${block.truncated === true ? `<p class="note">${escapeHtml(truncationNotice(block.removedChars))}</p>` : ''}</details>`;
    default:
      return '';
  }
}

/**
 * Render the view document as Markdown.
 * @param doc - a view document.
 * @returns the Markdown artifact.
 */
export function renderMarkdown(doc) {
  const t = labelsFor(doc.language);
  const session = doc.session;
  const summary = doc.summary;
  const lines = [];
  lines.push(`# ${session.title !== null ? session.title : session.id}`);
  lines.push('');
  lines.push(`- **${t.session}**: \`${session.id}\``);
  lines.push(`- **${t.created}**: ${formatTimestamp(session.createdAt)}`);
  if (session.cwd !== null) lines.push(`- **${t.workspace}**: \`${session.cwd}\``);
  if (session.model !== null) lines.push(`- **${t.model}**: \`${session.model.provider}/${session.model.model}\``);
  lines.push(`- **${t.turns}**: ${t.turnsValue(summary.turnSelected, summary.turnTotal, summary.turnRendered, summary.turnsSkipped)}`);
  lines.push(`- **${t.exported}**: ${formatTimestamp(doc.generatedAt)}`);
  lines.push(`- **${t.generator}**: ${PLUGIN_NAME} v${PLUGIN_VERSION}`);
  lines.push('');
  lines.push('<!-- dsh-session-export v1 -->');
  lines.push('');
  if (doc.preamble !== null) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${t.preamble}`);
    lines.push('');
    lines.push(doc.preamble.blocks.map((block) => blockToMarkdown(block, t)).filter((part) => part.length > 0).join('\n\n'));
    lines.push('');
  }
  for (const turn of doc.turns) {
    lines.push('---');
    lines.push('');
    const status = turn.open ? ` · ${t.open}` : turn.endReason !== null ? ` · ${turn.endReason}` : '';
    lines.push(`## ${t.turn} ${turn.turn} · ${formatTimestamp(turn.startedAt)}${status}`);
    lines.push('');
    lines.push(turn.blocks.map((block) => blockToMarkdown(block, t)).filter((part) => part.length > 0).join('\n\n'));
    lines.push('');
  }
  if (doc.turns.length === 0 && doc.preamble === null) {
    lines.push(`> ${t.noTurns}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

/** Inline stylesheet for the self-contained HTML export. */
const HTML_STYLE = `
:root { color-scheme: light dark; --fg:#1f2328; --bg:#ffffff; --muted:#59636e; --line:#d1d9e0; --code-bg:#f6f8fa; --accent:#0969da; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#9198a1; --line:#3d444d; --code-bg:#151b23; --accent:#4493f8; } }
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg); font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
main { max-width: 900px; margin: 0 auto; }
h1 { font-size:1.6rem; margin:0 0 .5rem; }
h2 { font-size:1.25rem; margin:2.5rem 0 .75rem; padding-top:1rem; border-top:1px solid var(--line); }
h3,h4,h5,h6 { font-size:1.05rem; margin:1.5rem 0 .5rem; }
a { color: var(--accent); }
code { font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em; }
:not(pre) > code { background: var(--code-bg); padding:.15em .35em; border-radius:4px; }
pre.md-code { background:var(--code-bg); border:1px solid var(--line); border-radius:8px; padding:.75rem 1rem; overflow:auto; max-height:32rem; }
pre.md-code code { white-space:pre-wrap; word-break:break-word; }
.meta { list-style:none; padding:0; margin:1rem 0 0; color:var(--muted); font-size:.9rem; }
.meta li { margin:.15rem 0; }
.meta code { color:var(--fg); }
.toc { margin:1.5rem 0 0; padding:.75rem 1rem; border:1px solid var(--line); border-radius:8px; font-size:.9rem; }
.toc ul { margin:.35rem 0 0; padding-left:1.2rem; }
.note { color:var(--muted); font-size:.9rem; }
details { border:1px solid var(--line); border-radius:8px; padding:.5rem .75rem; margin:1rem 0; }
details > summary { cursor:pointer; color:var(--muted); }
.ev { margin:1rem 0; }
.ev-marker, .ev-usage { color:var(--muted); font-size:.9rem; font-style:italic; }
.ev-tool-result.is-error h5 { color:#cf222e; }
figure.att { margin:1rem 0; }
figure.att img { max-width:100%; border:1px solid var(--line); border-radius:8px; }
figcaption { color:var(--muted); font-size:.85rem; margin-top:.35rem; }
.att { display:flex; gap:.5rem; align-items:baseline; border:1px solid var(--line); border-radius:8px; padding:.4rem .6rem; margin:.5rem 0; font-size:.9rem; }
.att-meta { color:var(--muted); }
.md > :first-child { margin-top:0; }
.md > :last-child { margin-bottom:0; }
blockquote { margin:1rem 0; padding:.25rem 1rem; border-left:3px solid var(--line); color:var(--muted); }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
img.md-image { max-width:100%; }
`.trim();

/**
 * Render the view document as a self-contained HTML document.
 * @param doc - a view document.
 * @param options - optional `images` lookup (`attachmentId -> data URI`).
 * @returns the HTML artifact.
 */
export function renderHtml(doc, options = {}) {
  const t = labelsFor(doc.language);
  const session = doc.session;
  const summary = doc.summary;
  const images = options.images instanceof Map ? options.images : new Map();
  const settings = { images, collapseThinking: doc.selection?.collapseThinking !== false };
  const title = session.title !== null ? session.title : session.id;
  const meta = [
    `<li><strong>${escapeHtml(t.session)}</strong>: <code>${escapeHtml(session.id)}</code></li>`,
    `<li><strong>${escapeHtml(t.created)}</strong>: ${formatTimestamp(session.createdAt)}</li>`,
  ];
  if (session.cwd !== null) meta.push(`<li><strong>${escapeHtml(t.workspace)}</strong>: <code>${escapeHtml(session.cwd)}</code></li>`);
  if (session.model !== null) {
    meta.push(`<li><strong>${escapeHtml(t.model)}</strong>: <code>${escapeHtml(`${session.model.provider}/${session.model.model}`)}</code></li>`);
  }
  meta.push(`<li><strong>${escapeHtml(t.turns)}</strong>: ${escapeHtml(t.turnsValue(summary.turnSelected, summary.turnTotal, summary.turnRendered, summary.turnsSkipped))}</li>`);
  meta.push(`<li><strong>${escapeHtml(t.exported)}</strong>: ${formatTimestamp(doc.generatedAt)}</li>`);
  meta.push(`<li><strong>${escapeHtml(t.generator)}</strong>: ${PLUGIN_NAME} v${PLUGIN_VERSION}</li>`);
  const blocks = (list) => list.map((block) => blockToHtml(block, t, settings)).filter((part) => part.length > 0).join('\n');
  const sections = [];
  if (doc.preamble !== null) {
    sections.push(`<section class="turn" id="preamble"><h2>${escapeHtml(t.preamble)}</h2>${blocks(doc.preamble.blocks)}</section>`);
  }
  for (const turn of doc.turns) {
    const status = turn.open ? ` · ${t.open}` : turn.endReason !== null ? ` · ${turn.endReason}` : '';
    sections.push(`<section class="turn" id="turn-${turn.turn}"><h2>${escapeHtml(`${t.turn} ${turn.turn}`)} · ${formatTimestamp(turn.startedAt)}${escapeHtml(status)}</h2>${blocks(turn.blocks)}</section>`);
  }
  if (sections.length === 0) sections.push(`<p class="note">${escapeHtml(t.noTurns)}</p>`);
  const tocEntries = [];
  if (doc.preamble !== null) tocEntries.push(`<li><a href="#preamble">${escapeHtml(t.preamble)}</a></li>`);
  for (const turn of doc.turns) {
    const label = `${t.turn} ${turn.turn}${turn.open ? ` (${t.open})` : ''}`;
    tocEntries.push(`<li><a href="#turn-${turn.turn}">${escapeHtml(label)}</a></li>`);
  }
  const toc = tocEntries.length > 0
    ? `<nav class="toc"><strong>${escapeHtml(t.contents)}</strong><ul>${tocEntries.join('')}</ul></nav>`
    : '';
  return `<!doctype html>
<html lang="${doc.language === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${PLUGIN_NAME} ${PLUGIN_VERSION}">
<title>${escapeHtml(title)}</title>
<style>
${HTML_STYLE}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<ul class="meta">
${meta.join('\n')}
</ul>
${toc}
${sections.join('\n')}
</main>
</body>
</html>
`;
}

/**
 * Render the raw-event JSON document.
 * @param doc - the JSON export document.
 * @returns the JSON artifact with a trailing newline.
 */
export function renderJson(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
