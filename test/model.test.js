/**
 * Unit tests for the pure transcript model.
 *
 * @module dsh-session-export/test/model.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SECTIONS, SECTION_ORDER, normalizeConfig } from '../lib/config.js';
import {
  buildJsonDocument,
  buildPlan,
  buildViewDocument,
  collectImageRefs,
  countEvents,
  exportFilename,
  filterEvent,
  filterEvents,
  normalizeSelection,
  promptPreviewOf,
  responsePreviewOf,
  segmentTurns,
  truncateText,
} from '../lib/model.js';
import { ALL_SECTIONS, VIEW_SECTIONS, sessionEvents, sessionHeader, sessionSnapshot, XSS_PAYLOAD } from './fixtures.js';

const CONFIG = normalizeConfig(undefined);

/** Build a plan for the synthetic session. */
function planFor(overrides = {}) {
  return buildPlan({
    header: sessionHeader(),
    title: '示例会话',
    inheritedEventCount: 0,
    events: sessionEvents(),
    config: CONFIG,
    attachmentsAvailable: true,
    ...overrides,
  });
}

/** Build the full view document under one selection. */
function viewFor(selection, plan = planFor()) {
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
      ...selection,
    },
    generatedAt: 1700000000000,
  });
}

test('segmentTurns splits preamble, closed turns, and an open tail', () => {
  const { preamble, turns } = segmentTurns(sessionEvents());
  assert.equal(preamble.events.length, 3);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2, 3]);
  assert.equal(turns[0].open, false);
  assert.equal(turns[0].endReason, 'completed');
  assert.equal(turns[1].endReason, 'aborted');
  assert.equal(turns[2].open, true);
  assert.equal(turns[2].endedAt, null);
  assert.equal(turns[0].events.length, 9);
});

test('countEvents classifies every event into the section vocabulary', () => {
  const totals = countEvents(sessionEvents());
  assert.deepEqual(totals, {
    user: 3,
    context: 1,
    assistant: 2,
    thinking: 3,
    toolCalls: 1,
    toolResults: 1,
    images: 1,
    files: 0,
    usage: 1,
    markers: 7,
    attempts: 1,
    stream: 2,
    other: 2,
  });
  assert.deepEqual(Object.keys(totals).sort(), [...SECTION_ORDER].sort());
});

test('buildPlan projects turn previews, counts, and session facts', () => {
  const plan = planFor();
  assert.equal(plan.session.id, 'session-1111-2222');
  assert.equal(plan.session.cwd, '/Users/tester/workspace');
  assert.equal(plan.session.title, '示例会话');
  assert.deepEqual(plan.session.model, { provider: 'alltokens', model: 'DeepSeek-V4-Flash' });
  assert.equal(plan.session.eventCount, sessionEvents().length);
  assert.equal(plan.turns.length, 3);
  assert.equal(plan.turns[0].prompt, '帮我看看 /x 这个文件 第二行');
  assert.equal(plan.turns[0].response, '这个文件有两行。');
  assert.equal(plan.turns[1].response, '');
  assert.equal(plan.turns[1].counts.attempts, 1);
  assert.equal(plan.turns[2].open, true);
  assert.equal(plan.preamble.counts.context, 1);
  assert.deepEqual(plan.sectionDefaults, DEFAULT_SECTIONS);
  assert.deepEqual(DEFAULT_SECTIONS, { user: true, assistant: true, context: false, thinking: false, toolCalls: false, toolResults: false, images: false, files: false, usage: false, markers: false, attempts: false, stream: false, other: false });
  assert.deepEqual(plan.capabilities, { attachments: true, formats: ['md', 'html', 'json'] });
});

test('buildPlan omits the preamble when the log starts inside a turn', () => {
  const events = sessionEvents().filter((event) => (event.seq ?? 0) >= 3);
  const plan = buildPlan({ header: sessionHeader(), title: null, inheritedEventCount: 0, events, config: CONFIG });
  assert.equal(plan.preamble, null);
  assert.equal(plan.turns[0].turn, 1);
});

test('promptPreviewOf and responsePreviewOf keep the first prompt and last reply', () => {
  const { turns } = segmentTurns(sessionEvents());
  assert.equal(promptPreviewOf(turns[0].events), '帮我看看 /x 这个文件 第二行');
  assert.equal(responsePreviewOf(turns[0].events), '这个文件有两行。');
  assert.equal(promptPreviewOf(turns[2].events), '还没结束的一轮');
});

test('truncateText reports the removed length', () => {
  const cut = truncateText('abcdef', 4);
  assert.equal(cut.text, 'abcd');
  assert.equal(cut.removed, 2);
  assert.equal(cut.truncated, true);
  assert.deepEqual(truncateText('abc', 10), { text: 'abc', removed: 0, truncated: false });
});

test('normalizeSelection validates turns, format, and options', () => {
  const plan = planFor();
  const all = normalizeSelection({ sessionId: 'session-1111-2222', format: 'md' }, plan, CONFIG);
  assert.equal(all.ok, true);
  assert.equal(all.selection.turns, null);
  assert.equal(all.selectedCount, 3);

  const subset = normalizeSelection({ sessionId: 'x', format: 'json', turns: [3, 1, 1] }, plan, CONFIG);
  assert.deepEqual(subset.selection.turns, [1, 3]);

  const none = normalizeSelection({ sessionId: 'x', format: 'md', turns: [] }, plan, CONFIG);
  assert.deepEqual(none.selection.turns, []);

  assert.equal(normalizeSelection({ sessionId: 'x', format: 'pdf' }, plan, CONFIG).code, 'INVALID_REQUEST');
  assert.equal(normalizeSelection({ format: 'md' }, plan, CONFIG).code, 'INVALID_REQUEST');
  assert.equal(normalizeSelection({ sessionId: 'x', format: 'md', turns: 'all' }, plan, CONFIG).code, 'INVALID_REQUEST');
  assert.equal(normalizeSelection({ sessionId: 'x', format: 'md', turns: [9] }, plan, CONFIG).code, 'INVALID_REQUEST');
  assert.equal(normalizeSelection({ sessionId: 'x', format: 'md', turns: [1.5] }, plan, CONFIG).code, 'INVALID_REQUEST');

  const capped = normalizeSelection({ sessionId: 'x', format: 'md', turns: [1, 2, 3] }, plan, { ...CONFIG, maxTurns: 2 });
  assert.equal(capped.code, 'TURNS_LIMIT_EXCEEDED');

  const options = normalizeSelection(
    { sessionId: 'x', format: 'md', options: { maxToolResultChars: 10, embedImages: 'yes', collapseThinking: false, language: 'en' } },
    plan,
    CONFIG,
  );
  assert.equal(options.selection.maxToolResultChars, 200);
  assert.equal(options.selection.embedImages, true);
  assert.equal(options.selection.collapseThinking, false);
  assert.equal(options.selection.language, 'en');
});

test('normalizeSelection merges partial section maps over the plan defaults', () => {
  const plan = planFor();
  const result = normalizeSelection({ sessionId: 'x', format: 'md', sections: { thinking: false, context: true } }, plan, CONFIG);
  assert.equal(result.selection.sections.thinking, false);
  assert.equal(result.selection.sections.context, true);
  assert.equal(result.selection.sections.user, true);
  assert.equal(Object.keys(result.selection.sections).length, SECTION_ORDER.length);
});

test('filterEvent gates events and content blocks by section', () => {
  const events = sessionEvents();
  const user = events.find((event) => event.type === 'user/message');
  assert.equal(filterEvent(user, { ...ALL_SECTIONS, user: false }), undefined);
  const injected = filterEvent(user, { ...ALL_SECTIONS, user: true, images: false });
  assert.equal(injected.data.content.length, 1);
  assert.equal(injected.data.content[0].type, 'text');
  assert.equal(user.data.content.length, 2, 'the source event must not be mutated');

  const assistant = events.find((event) => event.seq === 6);
  const thinkingOnly = filterEvent(assistant, { ...ALL_SECTIONS, assistant: false, usage: false, stream: false });
  assert.deepEqual(thinkingOnly.data.message.content.map((block) => block.type), ['reasoning', 'tool-call']);
  assert.equal(thinkingOnly.data.usage, undefined);
  assert.equal(thinkingOnly.data.stream, undefined);
  const reasoningOnly = filterEvent(assistant, { ...ALL_SECTIONS, assistant: false, toolCalls: false, usage: false, stream: false });
  assert.deepEqual(reasoningOnly.data.message.content.map((block) => block.type), ['reasoning']);

  const nothing = filterEvent(assistant, Object.fromEntries(SECTION_ORDER.map((id) => [id, false])));
  assert.equal(nothing, undefined);

  const toolResult = events.find((event) => event.type === 'tool/result');
  assert.equal(filterEvent(toolResult, { ...ALL_SECTIONS, toolResults: false }), undefined);

  const attempt = events.find((event) => event.type === 'assistant/attempt');
  assert.equal(filterEvent(attempt, { ...ALL_SECTIONS, attempts: false }), undefined);
  assert.deepEqual(filterEvent(attempt, { ...ALL_SECTIONS, attempts: true, stream: false }).data.stream, []);
  assert.equal(filterEvent(attempt, { ...ALL_SECTIONS, attempts: true, stream: true }).data.stream.length, 1);

  const header = events.find((event) => event.type === 'request/header');
  assert.equal(filterEvent(header, { ...ALL_SECTIONS, other: false }), undefined);
  assert.equal(filterEvent(header, { ...ALL_SECTIONS, other: true }).type, 'request/header');

  const marker = events.find((event) => event.type === 'turn/start');
  assert.equal(filterEvent(marker, { ...ALL_SECTIONS, markers: false }), undefined);
  assert.equal(filterEvent(marker, { ...ALL_SECTIONS, markers: true }).type, 'turn/start');
});

test('filterEvents keeps only the selected content', () => {
  const sections = { ...ALL_SECTIONS, context: false, other: false, markers: false, attempts: false };
  const kept = filterEvents(sessionEvents(), sections);
  assert.equal(kept.some((event) => event.type === 'request/header'), false);
  assert.equal(kept.some((event) => event.type === 'turn/start'), false);
  assert.equal(kept.some((event) => event.type === 'tool/call'), true);
});

test('buildJsonDocument groups selected turns and keeps empty selections', () => {
  const plan = planFor();
  const segments = segmentTurns(sessionEvents());
  const selection = {
    format: 'json',
    turns: [1, 2],
    includePreamble: true,
    sections: { ...VIEW_SECTIONS, thinking: false, assistant: false },
    maxToolResultChars: 20000,
    embedImages: true,
    collapseThinking: true,
    language: 'zh',
  };
  const doc = buildJsonDocument({ plan, segments, selection, generatedAt: 1700000000000 });
  assert.equal(doc.format, 'dsh-session-transcript');
  assert.equal(doc.generatedAt, undefined);
  assert.equal(doc.exportedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(doc.session.id, 'session-1111-2222');
  assert.deepEqual(doc.turns.map((turn) => turn.turn), [1, 2]);
  assert.equal(doc.turns[0].startSeq, 3);
  assert.equal(doc.turns[0].endSeq, 11);
  assert.equal(doc.preamble, null, 'the preamble holds only context/other events, both disabled here');

  const withPreamble = buildJsonDocument({
    plan,
    segments,
    selection: { ...selection, sections: { ...selection.sections, context: true, other: true } },
    generatedAt: 1700000000000,
  });
  assert.equal(withPreamble.preamble.eventCount, 3);

  const empty = buildJsonDocument({
    plan,
    segments,
    selection: { ...selection, sections: Object.fromEntries(SECTION_ORDER.map((id) => [id, false])) },
    generatedAt: 1700000000000,
  });
  assert.deepEqual(empty.turns.map((turn) => turn.events.length), [0, 0]);
  assert.equal(empty.preamble, null);
});

test('buildViewDocument renders blocks in chronological order and skips empty turns', () => {
  const { doc } = viewFor({});
  assert.equal(doc.summary.turnTotal, 3);
  assert.equal(doc.summary.turnSelected, 3);
  assert.equal(doc.summary.turnRendered, 3);
  const kinds = doc.turns[0].blocks.map((block) => block.kind);
  assert.deepEqual(kinds, ['user', 'thinking', 'assistant', 'tool-call', 'tool-result', 'thinking', 'assistant']);
  const toolCall = doc.turns[0].blocks[3];
  assert.equal(toolCall.name, 'read');
  assert.equal(toolCall.args, '{"file_path":"/x"}');
  const toolResult = doc.turns[0].blocks[4];
  assert.equal(toolResult.name, 'read');
  assert.equal(toolResult.text, 'file body\nsecond line');
  assert.equal(toolResult.isError, false);

  const { doc: filtered } = viewFor({ sections: { ...VIEW_SECTIONS, user: false, thinking: false, assistant: false, images: false, files: false, toolCalls: false } });
  assert.deepEqual(filtered.turns.map((turn) => turn.turn), [1]);
  assert.equal(filtered.summary.turnsSkipped, 2);
});

test('buildViewDocument truncates bulky tool bodies with an explicit notice', () => {
  const events = sessionEvents().map((event) => (event.type === 'tool/result'
    ? { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: 'y'.repeat(500) }] } } }
    : event));
  const plan = buildPlan({ header: sessionHeader(), title: null, inheritedEventCount: 0, events, config: CONFIG });
  const { doc } = buildViewDocument({
    plan,
    segments: segmentTurns(events),
    selection: {
      format: 'md',
      turns: [1],
      includePreamble: false,
      sections: { ...ALL_SECTIONS },
      maxToolResultChars: 100,
      embedImages: true,
      collapseThinking: true,
      language: 'zh',
    },
    generatedAt: 1700000000000,
  });
  const toolResult = doc.turns[0].blocks.find((block) => block.kind === 'tool-result');
  assert.equal(toolResult.truncated, true);
  assert.equal(toolResult.removedChars, 400);
  assert.equal(toolResult.text.length, 100);
});

test('buildViewDocument honors the preamble switch and exposes matches', () => {
  const { doc } = viewFor({ includePreamble: false });
  assert.equal(doc.preamble, null);
  const { doc: withPreamble } = viewFor({ includePreamble: true, sections: { ...ALL_SECTIONS, context: true, other: true } });
  assert.notEqual(withPreamble.preamble, null);
  assert.deepEqual(withPreamble.preamble.blocks.map((block) => block.kind), ['other', 'context', 'other']);
});

test('collectImageRefs deduplicates attachment ids', () => {
  const { doc } = viewFor({});
  const refs = collectImageRefs(doc);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].attachmentId, 'sha256:img1');
  assert.equal(refs[0].width, 10);
});

test('exportFilename is filesystem safe and deterministic', () => {
  assert.equal(exportFilename('session-1111-2222', 'md', Date.UTC(2023, 10, 14, 22, 13)), 'dsh-session-session-1111-2222-20231114-2213.md');
  assert.equal(exportFilename('../../etc/passwd', 'html', 0), 'dsh-session-______etc_passwd-19700101-0000.html');
});

test('the synthetic log carries the injection payload used by the render tests', () => {
  const found = sessionSnapshot().events.some((event) =>
    (event.data?.content ?? []).some((block) => typeof block.text === 'string' && block.text.includes(XSS_PAYLOAD)));
  assert.equal(found, true);
});
