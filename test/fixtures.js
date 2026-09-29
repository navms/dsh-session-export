/**
 * Synthetic session log used by every test.
 *
 * The shape mirrors the documented V4 event vocabulary exactly: session-role
 * events carry `data.source`/`data.content`, system/developer/tool/assistant
 * events carry `data.message`, and tool calls carry the raw argument string.
 *
 * @module dsh-session-export/test/fixtures
 */

import { SECTION_ORDER } from '../lib/config.js';

/** Injected payload that must never become live markup in an export. */
export const XSS_PAYLOAD = '<script>alert("xss")</script>';

/**
 * Every section enabled.
 *
 * Renderer and projection tests state their intent through this map instead of
 * riding the shipped defaults, so a policy change cannot silently rewrite what
 * they assert.
 */
export const ALL_SECTIONS = Object.fromEntries(SECTION_ORDER.map((id) => [id, true]));

/**
 * The section selection that yields the documented block sequence: everything
 * except lifecycle/marker noise and the bytes-heavy optional records.
 */
export const VIEW_SECTIONS = {
  ...ALL_SECTIONS,
  context: false,
  usage: false,
  markers: false,
  attempts: false,
  stream: false,
  other: false,
};

/** One content array that mixes text, reasoning, a tool call, an image, and a file. */
export function assistantContent() {
  return [
    { type: 'reasoning', text: '先确认文件是否存在。' },
    { type: 'text', text: '我先读取这个文件。' },
    { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"/x"}' },
  ];
}

/**
 * Build the session header.
 * @returns the header.
 */
export function sessionHeader() {
  return {
    version: 4,
    id: 'session-1111-2222',
    createdAt: 1700000000000,
    cwd: '/Users/tester/workspace',
    isSeeded: false,
  };
}

/**
 * Build the synthetic event log.
 * @returns the events in seq order.
 */
export function sessionEvents() {
  return [
    { type: 'request/header', seq: 0, time: 1000, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'system/message', seq: 1, time: 1000, data: { turn: 0, step: 0, message: { role: 'system', id: 'm0s', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'You are a coding agent.' }] } } },
    { type: 'session/end-seed', seq: 2, time: 1000, data: {} },
    { type: 'turn/start', seq: 3, time: 1001, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 4,
      time: 1002,
      data: {
        role: 'user',
        id: 'm1',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '帮我看看 /x 这个文件\n第二行' },
          { type: 'image', attachment: { attachmentId: 'sha256:img1', mediaType: 'image/png', bytes: 1234, width: 10, height: 20, name: 'shot.png' } },
        ],
      },
    },
    { type: 'step/start', seq: 5, time: 1003, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 6,
      time: 1004,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'm2',
          source: { kind: 'model', provider: 'alltokens', model: 'DeepSeek-V4-Flash' },
          content: assistantContent(),
        },
        stream: [{ type: 'text-chunks', time0: 1004, index: 0, dt: [1, 2], texts: ['我先读取', '这个文件。'] }],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    },
    { type: 'tool/call', seq: 7, time: 1005, data: { turn: 1, step: 1, callId: 'call_1', name: 'read', arguments: '{"file_path":"/x"}' } },
    {
      type: 'tool/result',
      seq: 8,
      time: 1006,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          id: 'm3',
          source: { kind: 'tool', callId: 'call_1' },
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'file body\nsecond line' }],
          isError: false,
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 9,
      time: 1007,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'm4',
          source: { kind: 'model', provider: 'alltokens', model: 'DeepSeek-V4-Flash' },
          content: [
            { type: 'reasoning', text: '总结一下。' },
            { type: 'text', text: '这个文件有两行。' },
          ],
        },
        stream: [],
      },
    },
    { type: 'step/end', seq: 10, time: 1008, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 11, time: 1009, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 12, time: 1100, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 13,
      time: 1101,
      data: {
        role: 'user',
        id: 'm5',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `再解释一下 ${XSS_PAYLOAD}` }],
      },
    },
    {
      type: 'assistant/message',
      seq: 14,
      time: 1102,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          id: 'm6',
          source: { kind: 'model', provider: 'alltokens', model: 'DeepSeek-V4-Flash' },
          content: [{ type: 'reasoning', text: '需要更详细的解释。' }],
        },
        stream: [],
      },
    },
    { type: 'assistant/attempt', seq: 15, time: 1103, data: { turn: 2, step: 1, stream: [{ type: 'text-chunks', time0: 1103, index: 0, dt: [1], texts: ['失败的尝试'] }] } },
    { type: 'turn/end', seq: 16, time: 1104, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    { type: 'turn/start', seq: 17, time: 1200, data: { turn: 3 } },
    {
      type: 'user/message',
      seq: 18,
      time: 1201,
      data: {
        role: 'user',
        id: 'm7',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '还没结束的一轮' }],
      },
    },
  ];
}

/**
 * Build a full session snapshot as `readSession` returns it.
 * @returns the snapshot.
 */
export function sessionSnapshot() {
  return { session: sessionHeader(), inheritedEventCount: 0, events: sessionEvents() };
}

/** A long tool-result body used to exercise truncation. */
export const LONG_BODY = 'x'.repeat(500);
