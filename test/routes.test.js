/**
 * Route-level tests: `apply` is driven through a fake host context, then the
 * registered handlers are called with real `Request` objects, so request
 * parsing, validation, status mapping, and response headers are all covered
 * without booting a harness.
 *
 * @module dsh-session-export/test/routes.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_PATH, PLUGIN_VERSION, RENDER_PATH } from '../lib/config.js';
import { apply, inject, name } from '../lib/index.js';
import { sessionSnapshot, XSS_PAYLOAD } from './fixtures.js';

/**
 * Build a fake `ctx` plus a session-query stub.
 * @param options - optional overrides for the session-query and attachment services.
 * @returns the harness.
 */
function harness(options = {}) {
  const routes = new Map();
  const effects = [];
  const services = new Map();
  const query = options.sessionQuery ?? {
    async readSession(sessionId) {
      if (sessionId === 'missing') {
        const error = new Error('session not listed');
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      if (sessionId === 'corrupt') {
        const error = new Error('replay validation failed');
        error.code = 'SESSION_QUERY_CORRUPT_SESSION';
        throw error;
      }
      return options.snapshot ?? sessionSnapshot();
    },
    async readTitle() {
      return { title: '示例会话', messageSeqs: [], source: 'fallback', eventSeq: 1, updatedAt: 1 };
    },
  };
  services.set('sessionQuery', query);
  services.set('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return async () => {
          routes.delete(route.path);
        };
      },
    },
  });
  if (options.attachments !== undefined) services.set('attachments', options.attachments);
  const ctx = {
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, disposer });
      return () => {};
    },
    get(id) {
      return services.get(id);
    },
  };
  for (const [id, value] of services) Reflect.set(ctx, id, value);
  return {
    ctx,
    routes,
    effects,
    query,
    plan: (url) => routes.get(PLAN_PATH).fetch(new Request(`http://localhost${url}`)),
    render: (body) => routes.get(RENDER_PATH).fetch(new Request(`http://localhost${RENDER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })),
  };
}

/**
 * Read one response as JSON.
 * @param response - the response.
 * @returns the parsed body.
 */
async function json(response) {
  return response.json();
}

test('apply registers both routes as fiber-owned effects', () => {
  const bench = harness();
  assert.equal(name, 'session-transcript-export');
  assert.deepEqual(inject, ['connection', 'sessionQuery']);
  apply(bench.ctx, undefined);
  assert.deepEqual([...bench.routes.keys()].sort(), [PLAN_PATH, RENDER_PATH].sort());
  assert.deepEqual(bench.routes.get(PLAN_PATH).methods, ['GET']);
  assert.deepEqual(bench.routes.get(RENDER_PATH).methods, ['POST']);
  assert.equal(bench.routes.get(RENDER_PATH).requestBody, 'buffered');
  assert.equal(bench.effects.length, 2);
});

test('the route effect disposer removes the registration', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  await bench.effects[0].disposer();
  assert.equal(bench.routes.has(PLAN_PATH), false);
  assert.equal(bench.routes.has(RENDER_PATH), true);
});

test('apply fails loud without a connection fetch registry', () => {
  const bench = harness();
  bench.ctx.get = () => undefined;
  delete bench.ctx.connection;
  assert.throws(() => apply(bench.ctx, undefined), /connection service/u);
});

test('the plan route returns picker metadata', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const response = await bench.plan(`${PLAN_PATH}?sessionId=session-1111-2222`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/u);
  const body = await json(response);
  assert.deepEqual(body.plugin, { name: 'dsh-session-export', version: PLUGIN_VERSION });
  assert.equal(body.session.id, 'session-1111-2222');
  assert.equal(body.session.title, '示例会话');
  assert.equal(body.turns.length, 3);
  assert.equal(body.sectionOrder.length, 13);
  // The shipped default is a plain conversation transcript: only the two message roles.
  assert.deepEqual(body.sectionDefaults, {
    user: true,
    assistant: true,
    context: false,
    thinking: false,
    toolCalls: false,
    toolResults: false,
    images: false,
    files: false,
    usage: false,
    markers: false,
    attempts: false,
    stream: false,
    other: false,
  });
  assert.equal(body.limits.maxTurns, 2000);
  assert.deepEqual(body.capabilities.formats, ['md', 'html', 'json']);
  assert.equal(body.preamble.eventCount, 3);
});

test('the plan route reports missing and over-long session ids', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const missing = await bench.plan(PLAN_PATH);
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).error.code, 'INVALID_REQUEST');
  const long = await bench.plan(`${PLAN_PATH}?sessionId=${'a'.repeat(300)}`);
  assert.equal(long.status, 400);
});

test('the plan route maps read failures onto status codes', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const absent = await bench.plan(`${PLAN_PATH}?sessionId=missing`);
  assert.equal(absent.status, 404);
  assert.equal((await json(absent)).error.code, 'SESSION_NOT_FOUND');
  const corrupt = await bench.plan(`${PLAN_PATH}?sessionId=corrupt`);
  assert.equal(corrupt.status, 422);
  assert.equal((await json(corrupt)).error.code, 'SESSION_UNREADABLE');
});

test('the plan route reports an unavailable session-query service', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  delete bench.ctx.sessionQuery;
  bench.ctx.get = () => undefined;
  const response = await bench.plan(`${PLAN_PATH}?sessionId=x`);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).error.code, 'SERVICE_UNAVAILABLE');
});

test('the render route returns a Markdown attachment', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const response = await bench.render({ sessionId: 'session-1111-2222', format: 'md' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/markdown/u);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="dsh-session-session-1111-2222-\d{8}-\d{4}\.md"$/u);
  const body = await response.text();
  assert.match(body, /^# 示例会话/u);
  assert.match(body, /## 轮次 1 ·/u);
  assert.match(body, /## 轮次 2 ·/u);
  assert.match(body, /## 轮次 3 ·/u);
});

test('the render route honors the turn and section selection', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const response = await bench.render({
    sessionId: 'session-1111-2222',
    format: 'md',
    turns: [2],
    includePreamble: false,
    sections: { thinking: false, user: true },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('## 轮次 1 ·'), false);
  assert.match(body, /## 轮次 2 ·/u);
  assert.equal(body.includes('## 轮次 3 ·'), false);
  assert.equal(body.includes('<summary>💭'), false);
  assert.equal(body.includes('会话前导'), false);
});

test('the render route returns self-contained HTML with embedded images', async () => {
  const bench = harness({
    attachments: {
      async readImage() {
        return { data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' } };
      },
    },
  });
  apply(bench.ctx, undefined);
  const response = await bench.render({ sessionId: 'session-1111-2222', format: 'html', turns: [1], sections: { user: true, images: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/u);
  const body = await response.text();
  assert.match(body, /^<!doctype html>/u);
  assert.match(body, /data:image\/png;base64,AQID/u);
  assert.equal(body.includes('<script'), false);
  assert.equal(body.includes(XSS_PAYLOAD), false);
});

test('the render route degrades when the attachment service is absent', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  // Attachments are opt-in now, so this test states the selection it needs.
  const response = await bench.render({ sessionId: 'session-1111-2222', format: 'html', turns: [1], sections: { user: true, images: true } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<div class="att att-image">/u);
  assert.equal(body.includes('data:image/png;base64'), false);
});

test('the render route returns raw-event JSON', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const response = await bench.render({ sessionId: 'session-1111-2222', format: 'json', turns: [1], sections: { usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/u);
  const doc = JSON.parse(await response.text());
  assert.equal(doc.format, 'dsh-session-transcript');
  assert.deepEqual(doc.turns.map((turn) => turn.turn), [1]);
  assert.equal(doc.turns[0].events.every((event) => typeof event.seq === 'number'), true);
  assert.equal(doc.session.title, '示例会话');
});

test('the render route rejects malformed and unknown requests', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const notJson = await bench.render('{oops');
  assert.equal(notJson.status, 400);
  assert.equal((await json(notJson)).error.code, 'INVALID_REQUEST');
  const noSession = await bench.render({ format: 'md' });
  assert.equal(noSession.status, 400);
  const badFormat = await bench.render({ sessionId: 'session-1111-2222', format: 'pdf' });
  assert.equal(badFormat.status, 400);
  assert.match((await json(badFormat)).error.message, /format must be one of/u);
  const badTurn = await bench.render({ sessionId: 'session-1111-2222', format: 'md', turns: [99] });
  assert.equal(badTurn.status, 400);
  assert.match((await json(badTurn)).error.message, /unknown turn 99/u);
  const absent = await bench.render({ sessionId: 'missing', format: 'md' });
  assert.equal(absent.status, 404);
});

test('the render route enforces the artifact byte budget', async () => {
  const huge = {
    session: sessionSnapshot().session,
    inheritedEventCount: 0,
    events: [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }, {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: { role: 'user', id: 'm', source: { kind: 'user' }, content: [{ type: 'text', text: 'y'.repeat(200000) }] },
    }],
  };
  const bench = harness({ sessionQuery: { async readSession() { return huge; } } });
  apply(bench.ctx, { maxOutputBytes: 65536 });
  const response = await bench.render({ sessionId: 'big', format: 'md', includePreamble: false });
  assert.equal(response.status, 413);
  assert.equal((await json(response)).error.code, 'OUTPUT_TOO_LARGE');
});

test('the artifact fails over to a header-only export when nothing is selected', async () => {
  const bench = harness();
  apply(bench.ctx, undefined);
  const response = await bench.render({ sessionId: 'session-1111-2222', format: 'md', turns: [], includePreamble: false });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /没有匹配所选条件的轮次。/u);
});
