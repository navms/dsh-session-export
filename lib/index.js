/**
 * Host half of the session transcript export plugin.
 *
 * Two authenticated routes over the shared `/api` channel:
 *
 * - `GET /api/session.transcript.plan` — picker metadata (turns, per-section
 *   counts, section defaults, limits) for one local session.
 * - `POST /api/session.transcript` — the rendered artifact (`md`/`html`/`json`)
 *   for one explicit turn/section selection.
 *
 * The session log comes from `ctx.sessionQuery.readSession` (live-preferred,
 * replay-validated) — the same local-disk data the rest of the GUI reads.
 * Attachment bytes are optional: without the attachment service the HTML
 * export degrades to placeholders instead of failing.
 *
 * The plugin declares no runtime dependencies and no Schemastery `Config`, so
 * Cordis hands the raw row configuration straight through and it can be
 * installed by symlink (see `scripts/install.mjs`).
 *
 * @module dsh-session-export
 */

import {
  FORMAT_CONTENT_TYPES,
  FORMAT_EXTENSIONS,
  MAX_SESSION_ID_LENGTH,
  PLAN_PATH,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  RENDER_PATH,
  normalizeConfig,
} from './config.js';
import {
  buildJsonDocument,
  buildPlan,
  buildViewDocument,
  collectImageRefs,
  exportFilename,
  normalizeSelection,
  segmentTurns,
} from './model.js';
import { renderHtml, renderJson, renderMarkdown } from './render.js';

/** Stable Cordis plugin name. */
export const name = 'session-transcript-export';

/** Services required before the routes can be registered. */
export const inject = ['connection', 'sessionQuery'];

/**
 * Read one service from a host context, tolerating both access styles.
 * @param ctx - the plugin context.
 * @param id - service id.
 * @returns the service, or `undefined`.
 */
function serviceOf(ctx, id) {
  if (typeof ctx.get === 'function') {
    const value = ctx.get(id);
    if (value !== undefined) return value;
  }
  return Reflect.get(ctx, id);
}

/**
 * Describe one error for a log or response message.
 * @param error - the caught value.
 * @returns the message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Measure a string as UTF-8 bytes.
 * @param text - the artifact text.
 * @returns the byte length.
 */
function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param body - serializable body.
 * @returns the response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Build one error response in the shared envelope.
 * @param status - HTTP status.
 * @param code - stable machine code.
 * @param message - human-readable message.
 * @returns the response.
 */
function errorResponse(status, code, message) {
  return jsonResponse(status, { error: { code, message } });
}

/**
 * Validate a session id appearing in a query string or request body.
 * @param value - candidate value.
 * @returns an error message, or `null` when acceptable.
 */
function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return 'sessionId is required';
  if (value.length > MAX_SESSION_ID_LENGTH) return `sessionId must be at most ${MAX_SESSION_ID_LENGTH} characters`;
  return null;
}

/**
 * Map one `readSession` failure onto a response triple.
 * @param error - the caught value.
 * @param sessionId - the requested session id.
 * @returns `{ status, code, message }`.
 */
function mapReadError(error, sessionId) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return { status: 404, code: 'SESSION_NOT_FOUND', message: `session "${sessionId}" was not found` };
  }
  if (code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_PERSISTENCE_FAILED') {
    return { status: 422, code: 'SESSION_UNREADABLE', message: `session "${sessionId}" could not be read: ${messageOf(error)}` };
  }
  return { status: 500, code: 'INTERNAL', message: `reading session "${sessionId}" failed: ${messageOf(error)}` };
}

/**
 * Fold the latest log-backed title, best effort.
 * @param ctx - the plugin context.
 * @param sessionId - the session id.
 * @returns the title text, or `null`.
 */
async function readTitleOf(ctx, sessionId) {
  const sessionQuery = serviceOf(ctx, 'sessionQuery');
  if (sessionQuery === undefined || typeof sessionQuery.readTitle !== 'function') return null;
  try {
    const snapshot = await sessionQuery.readTitle(sessionId);
    const title = snapshot?.title;
    return typeof title === 'string' && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/**
 * Read one session log and project it into a plan plus turn segmentation.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param sessionId - the session to read.
 * @returns `{ ok: true, plan, segments }` or `{ ok: false, status, code, message }`.
 */
async function loadSessionView(ctx, config, sessionId) {
  const sessionQuery = serviceOf(ctx, 'sessionQuery');
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { ok: false, status: 500, code: 'SERVICE_UNAVAILABLE', message: 'the session-query service is unavailable' };
  }
  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(sessionId);
  } catch (error) {
    return { ok: false, ...mapReadError(error, sessionId) };
  }
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const header = snapshot?.session ?? {};
  const title = await readTitleOf(ctx, sessionId);
  const plan = buildPlan({
    header,
    title,
    inheritedEventCount: snapshot?.inheritedEventCount,
    events,
    config,
    attachmentsAvailable: serviceOf(ctx, 'attachments') !== undefined,
  });
  return { ok: true, plan, segments: segmentTurns(events) };
}

/**
 * Resolve referenced image bytes into data URIs under a shared byte budget.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param doc - the view document.
 * @returns `attachmentId -> data URI` for the images that fit.
 */
async function resolveImages(ctx, config, doc) {
  const resolved = new Map();
  const attachments = serviceOf(ctx, 'attachments');
  if (config.maxEmbeddedImageBytes <= 0) return resolved;
  if (attachments === undefined || typeof attachments.readImage !== 'function') return resolved;
  let budget = config.maxEmbeddedImageBytes;
  for (const ref of collectImageRefs(doc)) {
    if (ref.bytes > budget) continue;
    try {
      const stored = await attachments.readImage(ref.ref);
      const bytes = stored?.data;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > budget) continue;
      budget -= bytes.byteLength;
      const mediaType = stored?.ref?.mediaType;
      const type = typeof mediaType === 'string' ? mediaType : ref.mediaType;
      resolved.set(ref.attachmentId, `data:${type};base64,${Buffer.from(bytes).toString('base64')}`);
    } catch {
      // A single unreadable image must not fail the whole export; it falls back to a placeholder.
    }
  }
  return resolved;
}

/**
 * Handle `GET /api/session.transcript.plan`.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param request - the admitted request.
 * @returns the plan response.
 */
async function handlePlan(ctx, config, request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  const invalid = validateSessionId(sessionId);
  if (invalid !== null) return errorResponse(400, 'INVALID_REQUEST', invalid);
  const loaded = await loadSessionView(ctx, config, sessionId);
  if (loaded.ok !== true) return errorResponse(loaded.status, loaded.code, loaded.message);
  return jsonResponse(200, {
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    ...loaded.plan,
  });
}

/**
 * Handle `POST /api/session.transcript`.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param request - the admitted request.
 * @returns the artifact response.
 */
async function handleRender(ctx, config, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'the request body must be valid JSON');
  }
  const sessionId = payload?.sessionId;
  const invalid = validateSessionId(sessionId);
  if (invalid !== null) return errorResponse(400, 'INVALID_REQUEST', invalid);
  const loaded = await loadSessionView(ctx, config, sessionId);
  if (loaded.ok !== true) return errorResponse(loaded.status, loaded.code, loaded.message);
  const validated = normalizeSelection(payload, loaded.plan, config);
  if (validated.ok !== true) return errorResponse(400, validated.code, validated.message);
  const generatedAt = Date.now();
  const selection = validated.selection;
  let artifact;
  if (selection.format === 'json') {
    artifact = renderJson(buildJsonDocument({ plan: loaded.plan, segments: loaded.segments, selection, generatedAt }));
  } else {
    const { doc } = buildViewDocument({ plan: loaded.plan, segments: loaded.segments, selection, generatedAt });
    if (selection.format === 'html') {
      const images = selection.embedImages === true ? await resolveImages(ctx, config, doc) : new Map();
      artifact = renderHtml(doc, { images });
    } else {
      artifact = renderMarkdown(doc);
    }
  }
  const bytes = byteLength(artifact);
  if (bytes > config.maxOutputBytes) {
    return errorResponse(413, 'OUTPUT_TOO_LARGE', `the export is ${bytes} bytes; the configured limit is ${config.maxOutputBytes}`);
  }
  const filename = exportFilename(sessionId, FORMAT_EXTENSIONS[selection.format], generatedAt);
  return new Response(artifact, {
    status: 200,
    headers: {
      'content-type': FORMAT_CONTENT_TYPES[selection.format],
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Register the export routes as fiber-owned effects.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const connection = serviceOf(ctx, 'connection');
  if (connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== 'function') {
    throw new Error(`${PLUGIN_NAME}: the connection service with a fetch registry is required`);
  }
  ctx.effect(
    () => connection.fetch.register({
      path: PLAN_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handlePlan(ctx, config, request),
    }),
    'session-transcript-export: plan route',
  );
  ctx.effect(
    () => connection.fetch.register({
      path: RENDER_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRender(ctx, config, request),
    }),
    'session-transcript-export: render route',
  );
}

/** Internals exposed for the test harness (not part of the plugin contract). */
export const __internals = {
  handlePlan,
  handleRender,
  loadSessionView,
  normalizeConfig,
  resolveImages,
  serviceOf,
};
