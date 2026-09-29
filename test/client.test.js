/**
 * Client-bundle tests: the shipped `window.__ModuleLoader__` bundle is loaded
 * into a stub module table, materialized with stub platform modules, and its
 * controller is then driven end to end (plan fetch, selection, render, save)
 * without a browser.
 *
 * @module dsh-session-export/test/client.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** The single registration the bundle is expected to publish. */
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    },
  },
};

await import('../lib/client.js');

/**
 * A minimal `createSnapshotStore` stand-in: structured-clone snapshots plus a
 * draft mutator, matching the observable contract the controller relies on.
 * @param initial - initial state.
 * @returns the store.
 */
function createSnapshotStore(initial) {
  let state = structuredClone(initial);
  const listeners = new Set();
  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutator) {
      const draft = structuredClone(state);
      mutator(draft);
      state = draft;
      for (const listener of [...listeners]) listener(state);
    },
    set(next) {
      state = structuredClone(next);
      for (const listener of [...listeners]) listener(state);
    },
  };
}

/** A no-op React stand-in that executes enough hooks to render the tree. */
const stubReact = {
  Fragment: Symbol('Fragment'),
  // Mirrors React.createElement's children rule: rest arguments win, and an
  // explicit `children` key survives when the call passes none.
  createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
};

/** Stub platform modules addressed by the bundle's `require`. */
const stubModules = {
  react: stubReact,
  'react/jsx-runtime': { jsx: stubReact.createElement, jsxs: stubReact.createElement },
  '@deepseek-ai/dsh-client-store': { createSnapshotStore },
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: () => null,
    Checkbox: () => null,
    Input: () => null,
    Switch: () => null,
    SegmentedControl: () => null,
    Modal: () => null,
    IconDownloadOutlineRegular: () => null,
  },
};

/**
 * Collect every element of a stubbed element tree, depth first.
 * @param node - an element, an array of nodes, or a scalar child.
 * @param out - accumulator.
 * @returns the collected elements.
 */
function collectElements(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (node.type !== undefined) out.push(node);
  collectElements(node.props?.children, out);
  return out;
}

/** The plan the stubbed host returns. */const PLAN = {
  plugin: { name: 'dsh-session-export', version: '0.1.0' },
  session: { id: 's1', title: '示例会话', createdAt: 1, cwd: '/tmp', model: null, eventCount: 4 },
  preamble: { eventCount: 1, counts: { other: 1 } },
  turns: [
    { turn: 1, seq: 1, startedAt: 10, endedAt: 20, endReason: 'completed', open: false, prompt: '你好', response: '好的', eventCount: 2, counts: { user: 1, assistant: 1 } },
    { turn: 2, seq: 3, startedAt: 30, endedAt: 40, endReason: 'completed', open: false, prompt: '再来', response: '', eventCount: 1, counts: { user: 1 } },
    { turn: 3, seq: 5, startedAt: 50, endedAt: null, endReason: null, open: true, prompt: '', response: '', eventCount: 1, counts: { assistant: 1 } },
  ],
  sectionOrder: ['user', 'context', 'assistant', 'thinking', 'toolCalls', 'toolResults', 'images', 'files', 'usage', 'markers', 'attempts', 'stream', 'other'],
  sectionDefaults: { user: true, context: false, assistant: true, thinking: false, toolCalls: false, toolResults: false, images: false, files: false, usage: false, markers: false, attempts: false, stream: false, other: false },
  totals: { events: 4, turns: 3, counts: {} },
  limits: { maxTurns: 2000, maxToolResultChars: 20000, maxOutputBytes: 33554432 },
  capabilities: { attachments: true, formats: ['md', 'html', 'json'] },
};

/** Materialize the bundle exports. */
function materialize() {
  assert.notEqual(registration, null);
  return registration.factory((specifier) => {
    if (!Object.hasOwn(stubModules, specifier)) throw new Error(`unexpected require("${specifier}")`);
    return stubModules[specifier];
  });
}

test('the bundle registers under the package name and materializes with platform modules only', () => {
  assert.equal(registration.id, 'dsh-session-export');
  assert.equal(typeof registration.factory, 'function');
  const exports = materialize();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(typeof exports.__internals.createController, 'function');
});

test('the controller loads a plan, tracks selection, and posts a render request', async () => {
  const exports = materialize();
  const calls = [];
  const saved = [];
  const fetcher = async (input, init) => {
    calls.push({ input, init });
    if (init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'attachment; filename="from-host.md"' },
        blob: async () => 'BLOB',
      };
    }
    return { ok: true, status: 200, json: async () => PLAN };
  };
  const controller = exports.__internals.createController({
    fetcher,
    save: (blob, filename) => saved.push({ blob, filename }),
    languageOf: () => 'en',
  });

  await controller.open('s1');
  const entry = controller.entryOf('s1');
  assert.equal(entry.phase, 'idle');
  assert.equal(entry.open, true);
  assert.deepEqual(entry.sections, PLAN.sectionDefaults);
  assert.equal(entry.options.maxToolResultChars, 20000);
  assert.match(calls[0].input, /^api\/session\.transcript\.plan\?sessionId=s1$/u);

  controller.toggleTurn('s1', 2, false);
  assert.deepEqual(controller.entryOf('s1').turns, [1, 3]);
  controller.toggleTurn('s1', 2, true);
  assert.equal(controller.entryOf('s1').turns, null);
  controller.selectAllTurns('s1', false);
  assert.deepEqual(controller.entryOf('s1').turns, []);
  controller.togglePreamble('s1', false);
  controller.toggleSection('s1', 'thinking', false);
  controller.setOption('s1', 'maxToolResultChars', 500);
  controller.setFormat('s1', 'json');
  assert.equal(controller.entryOf('s1').includePreamble, false);
  assert.equal(controller.entryOf('s1').sections.thinking, false);
  assert.equal(controller.entryOf('s1').options.maxToolResultChars, 500);
  controller.resetSections('s1');
  // Reset restores the plan's policy, which ships as user + assistant only.
  assert.equal(controller.entryOf('s1').sections.thinking, false);
  assert.equal(controller.entryOf('s1').sections.toolCalls, false);
  assert.equal(controller.entryOf('s1').sections.user, true);

  await controller.render('s1');
  const post = calls.find((call) => call.init?.method === 'POST');
  assert.equal(post.input, 'api/session.transcript');
  const body = JSON.parse(post.init.body);
  assert.deepEqual(body, {
    sessionId: 's1',
    format: 'json',
    turns: [],
    includePreamble: false,
    sections: PLAN.sectionDefaults,
    options: { maxToolResultChars: 500, embedImages: true, collapseThinking: true, language: 'en' },
  });
  assert.deepEqual(saved, [{ blob: 'BLOB', filename: 'from-host.md' }]);
  assert.equal(controller.entryOf('s1').phase, 'done');

  controller.close('s1');
  assert.equal(controller.entryOf('s1').open, false);
  await controller.dispose();
});

test('the controller surfaces plan and render failures', async () => {
  const exports = materialize();
  const planFailure = exports.__internals.createController({
    fetcher: async () => ({ ok: false, status: 404, text: async () => '{"error":{"code":"SESSION_NOT_FOUND","message":"gone"}}' }),
  });
  await planFailure.open('s2');
  assert.equal(planFailure.entryOf('s2').phase, 'error');
  assert.equal(planFailure.entryOf('s2').planError, 'gone');
  await planFailure.dispose();

  const renderFailure = exports.__internals.createController({
    fetcher: async (input, init) => (init?.method === 'POST'
      ? { ok: false, status: 400, text: async () => 'bad selection' }
      : { ok: true, status: 200, json: async () => PLAN }),
  });
  await renderFailure.open('s3');
  await renderFailure.render('s3');
  assert.equal(renderFailure.entryOf('s3').phase, 'error');
  assert.equal(renderFailure.entryOf('s3').error, 'HTTP 400: bad selection');
  await renderFailure.dispose();
});

test('render is a no-op before a plan is loaded and after disposal', async () => {
  const exports = materialize();
  const calls = [];
  const controller = exports.__internals.createController({
    fetcher: async (input, init) => {
      calls.push(init?.method ?? 'GET');
      return { ok: true, status: 200, json: async () => PLAN };
    },
  });
  await controller.render('s4');
  assert.deepEqual(calls, []);
  await controller.open('s4');
  await controller.dispose();
  await controller.render('s4');
  assert.deepEqual(calls, ['GET']);
});

test('apply registers the dictionaries and one header action', () => {
  const exports = materialize();
  const namespaces = [];
  const injected = [];
  const registrations = [];
  const effects = [];
  const ctx = {
    effect(callback, label) {
      effects.push(label);
      callback();
      return () => {};
    },
    locale: {
      getLocale: () => ({ active: 'zh-CN' }),
      register(namespace, dicts) {
        namespaces.push({ namespace, dicts });
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name);
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  assert.deepEqual(namespaces.map((entry) => entry.namespace), ['sessionTranscript']);
  const dicts = namespaces[0].dicts;
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort());
  assert.equal(dicts.zh['section.thinking'], '思考过程');
  assert.equal(dicts.en['section.thinking'], 'Thinking');
  assert.deepEqual(injected, ['conversation.session.header.actions']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.id, 'session-transcript-export');
  assert.equal(registrations[0].options.name, 'conversation.session.header.actions');
  assert.equal(registrations[0].options.locale, 'sessionTranscript');
  assert.equal(typeof registrations[0].options.inject().controller.open, 'function');
  assert.equal(Object.hasOwn(registrations[0].options.inject().hooks, 'sessionExport'), true);
  assert.equal(effects.length, 2);
});

test('the header action and dialog render against empty and populated state', () => {
  const exports = materialize();
  const controller = exports.__internals.createController({ fetcher: async () => ({ ok: true, status: 200, json: async () => PLAN }) });
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
  const action = exports.__internals.SessionTranscriptExportAction;
  const css = exports.__internals.css;

  const empty = action({ sessionId: 's1', controller, useSessionExport: () => undefined, t });
  assert.equal(Array.isArray(empty.props.children), true);

  const entry = {
    open: true,
    phase: 'idle',
    plan: PLAN,
    planError: null,
    error: null,
    format: 'md',
    turns: null,
    includePreamble: true,
    sections: { ...PLAN.sectionDefaults },
    options: { maxToolResultChars: 20000, embedImages: true, collapseThinking: true },
  };
  const populated = action({ sessionId: 's1', controller, useSessionExport: () => entry, t });
  assert.equal(populated.props.children.length, 2);
  const dialog = populated.props.children[1];
  assert.equal(dialog.type, exports.__internals.SessionTranscriptExportDialog);

  // Execute the dialog component (hooks are stubbed) to inspect what it renders.
  const rendered = dialog.type(dialog.props);
  const footer = rendered.props.footer;
  assert.notEqual(rendered.props.children, null);

  // The card shell stays reachable for restyling: the Modal primitive appends
  // `className` to its own card rule and `contentClassName` to the scroll region.
  assert.equal(rendered.props.className, css.dialog);
  assert.equal(rendered.props.contentClassName, css.dialogContent);
  assert.equal(css.dialog, 'dshSessionExportDialog');
  assert.equal(css.dialogContent, 'dshSessionExportDialogContent');

  // The footer is the reusable 取消 + 导出 pair, never a one-shot close.
  assert.equal(footer.type, stubReact.Fragment);
  assert.equal(footer.props.children.length, 2);
  assert.equal(footer.props.children[0].props.children, 'dialog.cancel');
  assert.equal(footer.props.children[1].props.children, 'dialog.export');
  assert.equal(footer.props.children[1].props.disabled, false);

  // A finished export keeps that pair and reports the download with a status line.
  const done = action({
    sessionId: 's1',
    controller,
    useSessionExport: () => ({ ...entry, phase: 'done' }),
    t,
  });
  const doneDialog = done.props.children[1];
  const doneRendered = doneDialog.type(doneDialog.props);
  assert.equal(doneRendered.props.footer.props.children[1].props.children, 'dialog.export');
  assert.equal(doneRendered.props.footer.props.children[1].props.disabled, false);
  const doneBody = doneRendered.props.children.props.children;
  assert.equal(doneBody[0].props.className, css.ok);
  assert.equal(doneBody[0].props.children, 'dialog.downloadStarted');

  // A failed render keeps the panel interactive and shows the reason inline.
  const failed = action({
    sessionId: 's1',
    controller,
    useSessionExport: () => ({ ...entry, phase: 'error', error: 'boom' }),
    t,
  });
  const failedDialog = failed.props.children[1];
  const failedRendered = failedDialog.type(failedDialog.props);
  assert.equal(failedRendered.props.footer.props.children[1].props.children, 'dialog.export');
  const failedBody = failedRendered.props.children.props.children;
  assert.equal(failedBody[0], null);
  assert.equal(failedBody[1].props.className, css.error);
  assert.equal(failedBody[1].props.children, 'boom');

  const loading = action({
    sessionId: 's1',
    controller,
    useSessionExport: () => ({ ...entry, phase: 'plan', plan: null }),
    t,
  });
  assert.equal(loading.props.children[1] !== null, true);

  // A malformed entry must degrade instead of throwing inside render.
  const broken = action({
    sessionId: 's1',
    controller,
    useSessionExport: () => ({ ...entry, turns: 1, sections: undefined }),
    t,
  });
  const brokenDialog = broken.props.children[1];
  assert.notEqual(brokenDialog.type(brokenDialog.props).props.footer, undefined);
});

test('a finished export leaves the dialog ready for another one', async () => {
  const exports = materialize();
  const posts = [];
  const saved = [];
  const controller = exports.__internals.createController({
    fetcher: async (input, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return { ok: true, status: 200, headers: { get: () => 'attachment; filename="a.md"' }, blob: async () => 'BLOB' };
      }
      return { ok: true, status: 200, json: async () => PLAN };
    },
    save: (blob, filename) => saved.push(filename),
  });
  await controller.open('s5');
  await controller.render('s5');
  assert.equal(controller.entryOf('s5').phase, 'done');

  // Exporting again must work without closing or reopening the dialog.
  await controller.render('s5');
  assert.equal(saved.length, 2);
  assert.equal(controller.entryOf('s5').phase, 'done');

  // A selection change clears the settled banner so the panel reads as fresh.
  controller.setFormat('s5', 'html');
  assert.equal(controller.entryOf('s5').phase, 'idle');
  controller.toggleTurn('s5', 2, false);
  await controller.render('s5');
  assert.equal(saved.length, 3);
  assert.equal(posts[2].format, 'html');
  assert.deepEqual(posts[2].turns, [1, 3]);
  await controller.dispose();
});

test('turn rows are clipped to one line and keep the full text in the tooltip', () => {
  const exports = materialize();
  const controller = exports.__internals.createController({ fetcher: async () => ({ ok: true, status: 200, json: async () => PLAN }) });
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
  const primitives = stubModules['@deepseek-ai/dsh-client-ui-primitives'];
  const entry = {
    open: true,
    phase: 'idle',
    plan: PLAN,
    planError: null,
    error: null,
    format: 'md',
    turns: null,
    includePreamble: true,
    sections: { ...PLAN.sectionDefaults },
    options: { maxToolResultChars: 20000, embedImages: true, collapseThinking: true },
  };
  const action = exports.__internals.SessionTranscriptExportAction({
    sessionId: 's1',
    controller,
    useSessionExport: () => entry,
    t,
  });
  const dialog = action.props.children[1];
  const { css } = exports.__internals;
  const rows = collectElements(dialog.type(dialog.props))
    .filter((element) => element.type === primitives.Checkbox && element.props.className === css.rowLabel);

  // One clipped row per selectable turn, plus the session preamble.
  assert.equal(rows.length, 4);

  /**
   * Read back the structural spans of one row label.
   * @param row - a row Checkbox element.
   * @returns the lead, prompt, count spans plus the whole span list.
   */
  const partsOf = (row) => {
    const wrapper = row.props.label;
    assert.equal(wrapper.props.className, css.rowText);
    const spans = wrapper.props.children;
    return {
      spans,
      lead: spans.find((span) => span.props.className === css.rowLead),
      prompt: spans.find((span) => span.props.className === css.rowPrompt),
      count: spans.find((span) => span.props.className === css.rowCount),
      last: spans[spans.length - 1],
    };
  };
  /** The text a browser derives for the label: every span's text in order. */
  const nameOf = (row) => partsOf(row).spans.map((span) => span.props.children).join(' ');

  const preamble = partsOf(rows[0]);
  assert.equal(preamble.lead.props.children, 'turns.preamble');
  // The preamble has no prompt, so its count sits directly after the lead.
  assert.equal(preamble.prompt, undefined);
  assert.equal(preamble.count.props.children, 'turns.count:{"n":1}');
  assert.equal(nameOf(rows[0]), 'turns.preamble · turns.count:{"n":1}');

  const turn1 = rows.find((row) => partsOf(row).lead.props.children === 'turns.turn:{"n":1}');
  const turn2 = rows.find((row) => partsOf(row).lead.props.children === 'turns.turn:{"n":2}');
  assert.notEqual(turn1, undefined);
  const turn1Parts = partsOf(turn1);
  const turn2Parts = partsOf(turn2);
  // Each row ends with its own full event count, so the ellipsis can never eat it.
  assert.equal(turn1Parts.last, turn1Parts.count);
  assert.equal(turn1Parts.count.props.children, 'turns.count:{"n":2}');
  assert.equal(turn2Parts.count.props.children, 'turns.count:{"n":1}');
  assert.equal(turn1Parts.prompt.props.children, '你好');
  assert.equal(turn2Parts.lead.props.children, 'turns.turn:{"n":2}');
  assert.equal(turn2Parts.prompt.props.children, '再来');

  // The tooltip holds the whole label, so nothing is lost to the ellipsis, and the
  // accessible name (every span in order) equals its first line.
  assert.equal(turn1.props.title, 'turns.turn:{"n":1} · 你好 · turns.count:{"n":2}\n好的');
  assert.equal(turn2.props.title, 'turns.turn:{"n":2} · 再来 · turns.count:{"n":1}');
  assert.equal(nameOf(turn1), turn1.props.title.split('\n')[0]);
  assert.equal(nameOf(turn2), turn2.props.title);
});

test('the stylesheet clips only the prompt and never the event count', () => {
  const { css, cssText } = materialize().__internals;
  assert.equal(css.rowLabel, 'dshSessionExportRowLabel');
  const rule = (selector) => {
    const found = new RegExp(`\\.${selector}\\{[^}]*\\}`, 'u').exec(cssText);
    assert.notEqual(found, null, `missing rule for .${selector}`);
    return found[0];
  };
  // Every flex container on the chain must drop the automatic min-content floor,
  // otherwise the card grows instead of the prompt shrinking.
  for (const selector of [css.rowLabel, css.rowText]) {
    assert.match(rule(selector), /min-width:0/u, selector);
  }
  assert.match(rule(css.rowLabel), /display:flex/u);
  assert.match(rule(`${css.rowLabel}.${css.rowLabel}>span`), /min-width:0/u);

  // The prompt absorbs all of the shrink…
  const prompt = rule(css.rowPrompt);
  assert.match(prompt, /min-width:0/u);
  assert.match(prompt, /overflow:hidden/u);
  assert.match(prompt, /white-space:nowrap/u);
  assert.match(prompt, /text-overflow:ellipsis/u);

  // …while the lead and the count are unshrinkable and unbreakable.
  for (const selector of [css.rowLead, css.rowCount]) {
    assert.match(rule(selector), /flex:0 0 auto/u, selector);
    assert.match(rule(selector), /white-space:nowrap/u, selector);
  }
});

test('filenameFromResponse prefers the host header and falls back locally', () => {
  const { filenameFromResponse } = materialize().__internals;
  assert.equal(filenameFromResponse({ headers: { get: () => 'attachment; filename="a-b.md"' } }, 's1', 'md'), 'a-b.md');
  assert.equal(filenameFromResponse({ headers: { get: () => '' } }, 's/1', 'html'), 'dsh-session-s_1.html');
  assert.equal(filenameFromResponse({}, 's1', 'json'), 'dsh-session-s1.json');
});
