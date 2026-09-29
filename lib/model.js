/**
 * Pure session-transcript model: turn segmentation, event classification,
 * plan construction, selection validation, and both export projections
 * (raw-event JSON and the format-agnostic view document).
 *
 * Every function here is pure and never mutates its inputs; the host route
 * layer owns I/O (reading the session, reading attachments) and the renderer
 * layer owns markup. That split is what makes the whole export pipeline
 * testable without a harness.
 *
 * @module dsh-session-export/model
 */

import {
  DEFAULT_SECTIONS,
  EXPORT_FORMATS,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  SECTION_ORDER,
  TOOL_RESULT_CHARS_CEILING,
  TOOL_RESULT_CHARS_FLOOR,
  asBoolean,
  asRecord,
  clampNumber,
  mergeSections,
} from './config.js';

/**
 * Deep-clone one JSON-safe value.
 * @param value - the value to clone.
 * @returns an independent copy.
 */
export function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Collapse whitespace and cap a one-line preview.
 * @param text - source text.
 * @param max - maximum code units before the ellipsis.
 * @returns the normalized preview, or an empty string.
 */
export function excerpt(text, max) {
  if (typeof text !== 'string') return '';
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Truncate a long body with an explicit, non-silent marker.
 * @param text - source text.
 * @param max - maximum retained code units; non-positive disables truncation.
 * @returns the retained text and whether truncation happened.
 */
export function truncateText(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return { text: value, removed: 0, truncated: false };
  const removed = value.length - max;
  return { text: `${value.slice(0, max)}`, removed, truncated: true };
}

/** Suffix appended to every truncated body. */
export function truncationNotice(removed) {
  return `… [已截断 ${removed} 字符 / truncated ${removed} chars]`;
}

/** Read one event's `data` object. */
export function eventData(event) {
  return asRecord(asRecord(event).data);
}

/** Read one event's `data.message` object. */
export function eventMessage(event) {
  return asRecord(eventData(event).message);
}

/**
 * Read a declared content array from a message-carrying event.
 * @param event - the event.
 * @returns the content block array, or an empty array.
 */
export function eventContent(event) {
  const content = eventContentValue(event);
  return Array.isArray(content) ? content : [];
}

/**
 * Read a declared content array from a raw message value.
 * @param value - message object or content array.
 * @returns the content array, or an empty array when absent.
 */
export function contentArrayOf(value) {
  if (Array.isArray(value)) return value;
  const content = asRecord(value).content;
  return Array.isArray(content) ? content : [];
}

/** @param event - the event. @returns the declared content value of `data.message` or `data`. */
function eventContentValue(event) {
  const data = eventData(event);
  if (Array.isArray(data.content)) return data.content;
  return eventMessage(event).content;
}

/** @param blocks - content blocks. @param type - block type. @returns whether any block has that type. */
export function hasBlockType(blocks, type) {
  return blocks.some((block) => asRecord(block).type === type);
}

/**
 * Concatenate every text block of a content array.
 * @param blocks - content blocks.
 * @param separator - joining separator.
 * @returns the joined text.
 */
export function textOfBlocks(blocks, separator = '\n\n') {
  const parts = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) parts.push(record.text);
  }
  return parts.join(separator);
}

/**
 * Concatenate every reasoning block of a content array.
 * @param blocks - content blocks.
 * @returns the joined reasoning text.
 */
export function reasoningOfBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record.type === 'reasoning' && typeof record.text === 'string' && record.text.length > 0) parts.push(record.text);
  }
  return parts.join('\n\n');
}

/**
 * Normalize one durable image reference for export.
 * @param block - an `image` content block.
 * @returns the normalized reference, or `null` when unusable.
 */
export function imageRefOf(block) {
  const attachment = asRecord(asRecord(block).attachment);
  if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length === 0) return null;
  return {
    attachmentId: attachment.attachmentId,
    mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'application/octet-stream',
    bytes: Number.isFinite(Number(attachment.bytes)) ? Number(attachment.bytes) : 0,
    width: Number.isFinite(Number(attachment.width)) ? Number(attachment.width) : 0,
    height: Number.isFinite(Number(attachment.height)) ? Number(attachment.height) : 0,
    name: typeof attachment.name === 'string' ? attachment.name : '',
    offloaded: asRecord(block).offloaded === true,
    ref: attachment,
  };
}

/**
 * Normalize one durable file reference for export.
 * @param block - a `file` content block.
 * @returns the normalized reference, or `null` when unusable.
 */
export function fileRefOf(block) {
  const attachment = asRecord(asRecord(block).attachment);
  if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length === 0) return null;
  return {
    attachmentId: attachment.attachmentId,
    name: typeof attachment.name === 'string' ? attachment.name : '',
    bytes: Number.isFinite(Number(attachment.bytes)) ? Number(attachment.bytes) : 0,
    ref: attachment,
  };
}

/**
 * Collect normalized image references from a content array.
 * @param blocks - content blocks.
 * @returns the references in block order.
 */
export function imagesOfBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    if (asRecord(block).type !== 'image') continue;
    const ref = imageRefOf(block);
    if (ref !== null) out.push(ref);
  }
  return out;
}

/**
 * Collect normalized file references from a content array.
 * @param blocks - content blocks.
 * @returns the references in block order.
 */
export function filesOfBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    if (asRecord(block).type !== 'file') continue;
    const ref = fileRefOf(block);
    if (ref !== null) out.push(ref);
  }
  return out;
}

/**
 * Reconstruct reader-visible text from one compact assistant stream.
 * @param stream - `AssistantStreamRecord[]`.
 * @returns the concatenated text, reasoning, and tool-call arguments.
 */
export function streamTextOf(stream) {
  if (!Array.isArray(stream)) return '';
  const parts = [];
  for (const record of stream) {
    const value = asRecord(record);
    switch (value.type) {
      case 'text-chunks':
      case 'reasoning-chunks':
        if (Array.isArray(value.texts)) for (const text of value.texts) if (typeof text === 'string') parts.push(text);
        break;
      case 'tool-call-chunks':
        if (Array.isArray(value.args)) for (const arg of value.args) if (typeof arg === 'string') parts.push(arg);
        break;
      case 'chunk': {
        const chunk = asRecord(value.chunk);
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          if (typeof chunk.text === 'string') parts.push(chunk.text);
        } else if (chunk.type === 'tool-call-delta') {
          if (typeof chunk.argumentsDelta === 'string') parts.push(chunk.argumentsDelta);
        } else if (chunk.type === 'block-end') {
          const block = asRecord(chunk.block);
          if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') parts.push(block.text);
        }
        break;
      }
      default:
        break;
    }
  }
  return parts.join('');
}

/**
 * Normalize one event's token usage fact for export.
 * @param usage - raw `TokenUsage` value.
 * @returns the normalized usage, or `null` when absent.
 */
export function usageOf(usage) {
  const record = asRecord(usage);
  if (Object.keys(record).length === 0) return null;
  return {
    inputTokens: Number.isFinite(Number(record.inputTokens)) ? Number(record.inputTokens) : 0,
    outputTokens: Number.isFinite(Number(record.outputTokens)) ? Number(record.outputTokens) : 0,
    totalTokens: Number.isFinite(Number(record.totalTokens)) ? Number(record.totalTokens) : null,
    cacheReadTokens: Number.isFinite(Number(record.cacheReadTokens)) ? Number(record.cacheReadTokens) : null,
    cacheWriteTokens: Number.isFinite(Number(record.cacheWriteTokens)) ? Number(record.cacheWriteTokens) : null,
    reasoningTokens: Number.isFinite(Number(record.reasoningTokens)) ? Number(record.reasoningTokens) : null,
  };
}

/** Turn/step lifecycle event types treated as markers. */
const MARKER_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end']);

/**
 * Count one event into the section vocabulary.
 *
 * Counting is per section *presence*, not per rendered unit: one assistant
 * message that carries both text and reasoning counts once for `assistant`
 * and once for `thinking`, which is exactly what the picker shows.
 * @param event - one session event.
 * @returns a partial section-count map.
 */
export function countEvent(event) {
  const counts = {};
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  const type = asRecord(event).type;
  const data = eventData(event);
  const content = eventContent(event);
  if (type === 'user/message') {
    if (asRecord(data.source).kind === 'user') bump('user');
    else bump('context');
    if (imagesOfBlocks(content).length > 0) bump('images');
    if (filesOfBlocks(content).length > 0) bump('files');
    return counts;
  }
  if (type === 'system/message' || type === 'developer/message') {
    bump('context');
    if (imagesOfBlocks(content).length > 0) bump('images');
    if (filesOfBlocks(content).length > 0) bump('files');
    return counts;
  }
  if (type === 'assistant/message') {
    if (hasBlockType(content, 'text')) bump('assistant');
    if (hasBlockType(content, 'reasoning')) bump('thinking');
    if (imagesOfBlocks(content).length > 0) bump('images');
    if (filesOfBlocks(content).length > 0) bump('files');
    if (usageOf(data.usage) !== null) bump('usage');
    if (Array.isArray(data.stream) && data.stream.length > 0) bump('stream');
    return counts;
  }
  if (type === 'assistant/attempt') {
    bump('attempts');
    if (Array.isArray(data.stream) && data.stream.length > 0) bump('stream');
    return counts;
  }
  if (type === 'tool/call') {
    bump('toolCalls');
    return counts;
  }
  if (type === 'tool/result') {
    bump('toolResults');
    if (imagesOfBlocks(content).length > 0) bump('images');
    if (filesOfBlocks(content).length > 0) bump('files');
    return counts;
  }
  if (MARKER_TYPES.has(type)) {
    bump('markers');
    return counts;
  }
  bump('other');
  return counts;
}

/**
 * Sum per-event counts into one section map.
 * @param events - session events.
 * @returns a complete section-count map.
 */
export function countEvents(events) {
  const totals = {};
  for (const id of SECTION_ORDER) totals[id] = 0;
  for (const event of events) {
    const counts = countEvent(event);
    for (const [id, value] of Object.entries(counts)) totals[id] = (totals[id] ?? 0) + value;
  }
  return totals;
}

/**
 * Segment a session log into an optional preamble plus one bucket per turn.
 *
 * Events before the first `turn/start` form the preamble; every later event
 * attaches to the most recent `turn/start`. A turn whose `turn/end` never
 * landed (a live or crashed session) stays `open`.
 * @param events - validated session events in seq order.
 * @returns `{ preamble, turns }` with cloned event arrays omitted (references only).
 */
export function segmentTurns(events) {
  const turns = [];
  let preamble = null;
  let current = null;
  for (const event of events) {
    const type = asRecord(event).type;
    if (type === 'turn/start') {
      const raw = Number(eventData(event).turn);
      current = {
        turn: Number.isFinite(raw) ? raw : turns.length + 1,
        seq: event.seq,
        startedAt: event.time,
        endedAt: null,
        endReason: null,
        open: true,
        events: [event],
      };
      turns.push(current);
      continue;
    }
    if (current === null) {
      if (preamble === null) preamble = { events: [], firstSeq: event.seq };
      preamble.events.push(event);
      continue;
    }
    current.events.push(event);
    if (type === 'turn/end') {
      current.endedAt = event.time;
      const reason = asRecord(eventData(event).reason);
      current.endReason = typeof reason.kind === 'string' ? reason.kind : null;
      current.open = false;
    }
  }
  return { preamble, turns };
}

/**
 * Read one turn's prompt preview from its first human message.
 * @param events - the turn's events.
 * @returns the preview, or an empty string.
 */
export function promptPreviewOf(events) {
  for (const event of events) {
    if (asRecord(event).type !== 'user/message') continue;
    if (asRecord(eventData(event).source).kind !== 'user') continue;
    const text = textOfBlocks(eventContent(event), ' ');
    if (text.length > 0) return excerpt(text, 80);
  }
  return '';
}

/**
 * Read one turn's settled-response preview from its last text-bearing assistant message.
 * @param events - the turn's events.
 * @returns the preview, or an empty string.
 */
export function responsePreviewOf(events) {
  let preview = '';
  for (const event of events) {
    if (asRecord(event).type !== 'assistant/message') continue;
    const text = textOfBlocks(eventContent(event), ' ');
    if (text.length > 0) preview = excerpt(text, 120);
  }
  return preview;
}

/**
 * Read the last routed model identity from a session log.
 * @param events - session events.
 * @returns `{ provider, model }`, or `null` when the log carries none.
 */
export function modelOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (asRecord(event).type !== 'assistant/message') continue;
    const source = asRecord(eventMessage(event).source);
    if (typeof source.provider === 'string' && typeof source.model === 'string') {
      return { provider: source.provider, model: source.model };
    }
  }
  return null;
}

/**
 * Project a session id into one filesystem- and header-safe path segment.
 * @param id - raw session id.
 * @returns the sanitized segment.
 */
export function safeIdSegment(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80);
}

/**
 * Build the export download filename.
 * @param sessionId - the source session id.
 * @param extension - file extension without the dot.
 * @param at - timestamp used for the name.
 * @returns the filename.
 */
export function exportFilename(sessionId, extension, at) {
  const stamp = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  const text = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}`;
  return `dsh-session-${safeIdSegment(sessionId)}-${text}.${extension}`;
}

/**
 * Build the picker metadata for one session.
 * @param input - header, title, log facts, and resolved configuration.
 * @returns the plan document served by the plan route.
 */
export function buildPlan(input) {
  const { header, title, inheritedEventCount, events, config, attachmentsAvailable } = input;
  const source = asRecord(header);
  const { preamble, turns } = segmentTurns(events);
  const allCounts = countEvents(events);
  const projected = turns.map((turn) => {
    const counts = countEvents(turn.events);
    return {
      turn: turn.turn,
      seq: turn.seq,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      endReason: turn.endReason,
      open: turn.open,
      prompt: promptPreviewOf(turn.events),
      response: responsePreviewOf(turn.events),
      eventCount: turn.events.length,
      counts,
    };
  });
  return {
    session: {
      id: String(source.id ?? ''),
      createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : 0,
      cwd: typeof source.cwd === 'string' ? source.cwd : null,
      isSeeded: source.isSeeded === true,
      parentSession: typeof source.parentSession === 'string' ? source.parentSession : null,
      origin: typeof source.origin === 'string' ? source.origin : null,
      delegationDepth: Number.isFinite(Number(source.delegationDepth)) ? Number(source.delegationDepth) : 0,
      agentPreset: typeof source.agentPreset === 'string' ? source.agentPreset : null,
      title: typeof title === 'string' && title.length > 0 ? title : null,
      model: modelOf(events),
      eventCount: events.length,
      inheritedEventCount: Number.isFinite(Number(inheritedEventCount)) ? Number(inheritedEventCount) : 0,
    },
    preamble: preamble === null ? null : { eventCount: preamble.events.length, counts: countEvents(preamble.events) },
    turns: projected,
    sectionOrder: SECTION_ORDER,
    sectionDefaults: config.defaultSections,
    totals: { events: events.length, turns: turns.length, counts: allCounts },
    limits: {
      maxTurns: config.maxTurns,
      maxToolResultChars: config.maxToolResultChars,
      maxOutputBytes: config.maxOutputBytes,
    },
    capabilities: { attachments: attachmentsAvailable === true, formats: EXPORT_FORMATS },
  };
}

/**
 * Validate and normalize one render request against its plan.
 * @param payload - the parsed request body.
 * @param plan - the session's plan document.
 * @param config - the resolved plugin configuration.
 * @returns `{ ok: true, selection }` or `{ ok: false, code, message }`.
 */
export function normalizeSelection(payload, plan, config) {
  const body = asRecord(payload);
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'sessionId is required' };
  }
  if (!EXPORT_FORMATS.includes(body.format)) {
    return { ok: false, code: 'INVALID_REQUEST', message: `format must be one of ${EXPORT_FORMATS.join(', ')}` };
  }
  const knownTurns = plan.turns.map((turn) => turn.turn);
  const known = new Set(knownTurns);
  let turns = null;
  if (body.turns !== undefined && body.turns !== null) {
    if (!Array.isArray(body.turns)) return { ok: false, code: 'INVALID_REQUEST', message: 'turns must be an array of turn numbers or null' };
    const requested = new Set();
    for (const value of body.turns) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, code: 'INVALID_REQUEST', message: 'turns must contain integers' };
      }
      if (!known.has(value)) return { ok: false, code: 'INVALID_REQUEST', message: `unknown turn ${value}` };
      requested.add(value);
    }
    turns = knownTurns.filter((turn) => requested.has(turn));
  }
  const selectedCount = turns === null ? knownTurns.length : turns.length;
  if (selectedCount > config.maxTurns) {
    return {
      ok: false,
      code: 'TURNS_LIMIT_EXCEEDED',
      message: `${selectedCount} turns selected; the configured limit is ${config.maxTurns}`,
    };
  }
  const options = asRecord(body.options);
  const sections = mergeSections(body.sections, plan.sectionDefaults ?? DEFAULT_SECTIONS);
  return {
    ok: true,
    selection: {
      format: body.format,
      turns,
      includePreamble: asBoolean(body.includePreamble, true),
      sections,
      maxToolResultChars: clampNumber(
        options.maxToolResultChars,
        Math.min(config.maxToolResultChars, plan.limits.maxToolResultChars),
        TOOL_RESULT_CHARS_FLOOR,
        TOOL_RESULT_CHARS_CEILING,
      ),
      embedImages: asBoolean(options.embedImages, true),
      collapseThinking: asBoolean(options.collapseThinking, true),
      language: options.language === 'en' ? 'en' : 'zh',
    },
    selectedCount,
  };
}

/** Section id owning a message's text blocks, keyed by content owner. */
const OWNER_SECTION = { user: 'user', context: 'context', assistant: 'assistant', tool: 'toolResults' };

/**
 * Filter one declared content array down to the enabled block types.
 * @param blocks - raw content blocks.
 * @param sections - the section selection.
 * @param owner - which section owns this content's text blocks.
 * @returns the retained blocks.
 */
export function filterContent(blocks, sections, owner) {
  if (!Array.isArray(blocks)) return [];
  const textSection = OWNER_SECTION[owner] ?? 'other';
  const out = [];
  for (const block of blocks) {
    const record = asRecord(block);
    switch (record.type) {
      case 'text':
        if (sections[textSection] === true) out.push(cloneValue(record));
        break;
      case 'reasoning':
        if (sections.thinking === true) out.push(cloneValue(record));
        break;
      case 'tool-call':
        if (sections.toolCalls === true) out.push(cloneValue(record));
        break;
      case 'image':
        if (sections.images === true) out.push(cloneValue(record));
        break;
      case 'file':
        if (sections.files === true) out.push(cloneValue(record));
        break;
      default:
        if (sections[textSection] === true) out.push(cloneValue(record));
        break;
    }
  }
  return out;
}

/**
 * Filter one session event for a raw JSON export.
 * @param event - the session event.
 * @param sections - the section selection.
 * @returns the retained event, or `undefined` when nothing survives.
 */
export function filterEvent(event, sections) {
  const type = asRecord(event).type;
  const data = eventData(event);
  const withData = (nextData) => {
    const cloned = cloneValue(event);
    cloned.data = nextData;
    return cloned;
  };
  switch (type) {
    case 'user/message': {
      const isUser = asRecord(data.source).kind === 'user';
      const owner = isUser ? 'user' : 'context';
      if (sections[owner] !== true) return undefined;
      const content = filterContent(data.content, sections, owner);
      if (content.length === 0) return undefined;
      return withData({ ...cloneValue(data), content });
    }
    case 'system/message':
    case 'developer/message': {
      if (sections.context !== true) return undefined;
      const content = filterContent(eventContent(event), sections, 'context');
      if (content.length === 0) return undefined;
      return withData({ ...cloneValue(data), message: { ...cloneValue(eventMessage(event)), content } });
    }
    case 'assistant/message': {
      const content = filterContent(eventContent(event), sections, 'assistant');
      const next = { ...cloneValue(data), message: { ...cloneValue(eventMessage(event)), content } };
      if (sections.usage !== true) delete next.usage;
      if (sections.stream !== true) delete next.stream;
      const hasUsage = next.usage !== undefined && next.usage !== null;
      const hasStream = Array.isArray(next.stream) && next.stream.length > 0;
      if (content.length === 0 && !hasUsage && !hasStream) return undefined;
      return withData(next);
    }
    case 'assistant/attempt': {
      if (sections.attempts !== true) return undefined;
      const next = cloneValue(data);
      if (sections.stream !== true || !Array.isArray(next.stream)) next.stream = [];
      return withData(next);
    }
    case 'tool/call':
      return sections.toolCalls === true ? cloneValue(event) : undefined;
    case 'tool/result': {
      if (sections.toolResults !== true) return undefined;
      const content = filterContent(eventContent(event), sections, 'tool');
      if (content.length === 0) return undefined;
      return withData({ ...cloneValue(data), message: { ...cloneValue(eventMessage(event)), content } });
    }
    default:
      if (MARKER_TYPES.has(type)) return sections.markers === true ? cloneValue(event) : undefined;
      return sections.other === true ? cloneValue(event) : undefined;
  }
}

/**
 * Filter a whole event list for a raw JSON export.
 * @param events - session events.
 * @param sections - the section selection.
 * @returns the retained events.
 */
export function filterEvents(events, sections) {
  const out = [];
  for (const event of events) {
    const filtered = filterEvent(event, sections);
    if (filtered !== undefined) out.push(filtered);
  }
  return out;
}

/**
 * Record `callId -> tool name` pairs so tool results can name their call.
 * @param event - one session event.
 * @param target - the accumulating map.
 */
function rememberCallNames(event, target) {
  if (asRecord(event).type !== 'tool/call') return;
  const data = eventData(event);
  if (typeof data.callId === 'string' && typeof data.name === 'string') target.set(data.callId, data.name);
}

/**
 * Read the producer kind that labels one injected-context block.
 * @param source - the message source.
 * @returns a short label.
 */
function contextLabelOf(source) {
  const record = asRecord(source);
  if (typeof record.kind === 'string') return record.kind;
  return 'context';
}

/**
 * Build the ordered, format-agnostic block list for one event range.
 * @param events - events to project.
 * @param sections - the section selection.
 * @param maxToolResultChars - truncation budget for bulky bodies.
 * @param callNames - `callId -> name` map built from the whole log.
 * @returns the block list.
 */
export function buildBlocks(events, sections, maxToolResultChars, callNames) {
  const blocks = [];
  for (const event of events) {
    const type = asRecord(event).type;
    const data = eventData(event);
    const content = eventContent(event);
    const base = { seq: event.seq, time: event.time, type };
    if (type === 'user/message') {
      const isUser = asRecord(data.source).kind === 'user';
      const owner = isUser ? 'user' : 'context';
      if (sections[owner] !== true) continue;
      const text = textOfBlocks(content);
      const images = sections.images === true ? imagesOfBlocks(content) : [];
      const files = sections.files === true ? filesOfBlocks(content) : [];
      if (text.length === 0 && images.length === 0 && files.length === 0) continue;
      blocks.push({ ...base, kind: isUser ? 'user' : 'context', label: contextLabelOf(data.source), form: data.source?.form ?? null, text, images, files });
      continue;
    }
    if (type === 'system/message' || type === 'developer/message') {
      if (sections.context !== true) continue;
      const text = textOfBlocks(content);
      const images = sections.images === true ? imagesOfBlocks(content) : [];
      const files = sections.files === true ? filesOfBlocks(content) : [];
      if (text.length === 0 && images.length === 0 && files.length === 0) continue;
      blocks.push({ ...base, kind: 'context', label: type === 'system/message' ? 'system' : 'developer', form: null, text, images, files });
      continue;
    }
    if (type === 'assistant/message') {
      if (sections.thinking === true) {
        const reasoning = reasoningOfBlocks(content);
        if (reasoning.length > 0) blocks.push({ ...base, kind: 'thinking', text: reasoning });
      }
      const text = textOfBlocks(content);
      const images = sections.images === true ? imagesOfBlocks(content) : [];
      const files = sections.files === true ? filesOfBlocks(content) : [];
      const visibleText = sections.assistant === true ? text : '';
      if (visibleText.length > 0 || images.length > 0 || files.length > 0) {
        blocks.push({ ...base, kind: 'assistant', text: visibleText, images, files, interrupted: data.interrupted === true });
      }
      const usage = sections.usage === true ? usageOf(data.usage) : null;
      if (usage !== null) blocks.push({ ...base, kind: 'usage', usage });
      if (sections.stream === true) {
        const stream = streamTextOf(data.stream);
        if (stream.length > 0) blocks.push({ ...base, kind: 'stream', text: stream });
      }
      continue;
    }
    if (type === 'assistant/attempt') {
      if (sections.attempts !== true) continue;
      const stream = sections.stream === true ? streamTextOf(data.stream) : '';
      blocks.push({ ...base, kind: 'attempt', text: stream });
      continue;
    }
    if (type === 'tool/call') {
      if (sections.toolCalls !== true) continue;
      blocks.push({
        ...base,
        kind: 'tool-call',
        callId: typeof data.callId === 'string' ? data.callId : null,
        name: typeof data.name === 'string' ? data.name : 'tool',
        args: typeof data.arguments === 'string' ? data.arguments : '',
      });
      continue;
    }
    if (type === 'tool/result') {
      if (sections.toolResults !== true) continue;
      const message = eventMessage(event);
      const resultContent = Array.isArray(data.content) ? data.content : contentArrayOf(message);
      const body = truncateText(textOfBlocks(resultContent), maxToolResultChars);
      const images = sections.images === true ? imagesOfBlocks(resultContent) : [];
      const files = sections.files === true ? filesOfBlocks(resultContent) : [];
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : null;
      blocks.push({
        ...base,
        kind: 'tool-result',
        callId,
        name: callId !== null && callNames.has(callId) ? callNames.get(callId) : null,
        isError: message.isError === true,
        errorText: typeof asRecord(data.error).reason === 'string' ? data.error.reason : null,
        errorCode: typeof asRecord(data.error).code === 'string' ? data.error.code : null,
        text: body.text,
        truncated: body.truncated === true,
        removedChars: body.removed ?? 0,
        images,
        files,
      });
      continue;
    }
    if (MARKER_TYPES.has(type)) {
      if (sections.markers !== true) continue;
      blocks.push({ ...base, kind: 'marker', text: markerTextOf(type, data) });
      continue;
    }
    if (sections.other !== true) continue;
    const json = truncateText(JSON.stringify({ seq: event.seq, time: event.time, type, data }, null, 2), maxToolResultChars);
    blocks.push({ ...base, kind: 'other', text: json.text, truncated: json.truncated === true, removedChars: json.removed ?? 0 });
  }
  return blocks;
}

/**
 * Describe one lifecycle marker.
 * @param type - the marker event type.
 * @param data - the event data.
 * @returns a one-line description.
 */
function markerTextOf(type, data) {
  const turn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : null;
  const step = Number.isFinite(Number(data.step)) ? Number(data.step) : null;
  const reason = asRecord(data.reason).kind;
  switch (type) {
    case 'turn/start':
      return `turn ${turn ?? '?'} start`;
    case 'turn/end':
      return `turn ${turn ?? '?'} end (${typeof reason === 'string' ? reason : 'unknown'})`;
    case 'step/start':
      return `turn ${turn ?? '?'} · step ${step ?? '?'} start`;
    default:
      return `turn ${turn ?? '?'} · step ${step ?? '?'} end`;
  }
}

/**
 * Collect the distinct image references carried by a view document.
 * @param doc - a view document.
 * @returns the distinct references in first-seen order.
 */
export function collectImageRefs(doc) {
  const seen = new Map();
  const visit = (blocks) => {
    for (const block of blocks ?? []) {
      for (const image of block.images ?? []) if (!seen.has(image.attachmentId)) seen.set(image.attachmentId, image);
    }
  };
  visit(doc.preamble?.blocks);
  for (const turn of doc.turns) visit(turn.blocks);
  return [...seen.values()];
}

/**
 * Build the raw-event JSON export document.
 * @param input - plan, segmentation, selection, and generation time.
 * @returns the JSON document.
 */
export function buildJsonDocument(input) {
  const { plan, segments, selection, generatedAt } = input;
  const selectedTurns = selection.turns === null ? segments.turns.map((turn) => turn.turn) : selection.turns;
  const selected = new Set(selectedTurns);
  const doc = {
    format: 'dsh-session-transcript',
    version: 1,
    exportedAt: new Date(generatedAt).toISOString(),
    generator: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    selection: {
      format: selection.format,
      turns: selection.turns,
      includePreamble: selection.includePreamble,
      sections: selection.sections,
      options: {
        maxToolResultChars: selection.maxToolResultChars,
        embedImages: selection.embedImages,
        collapseThinking: selection.collapseThinking,
        language: selection.language,
      },
    },
    session: plan.session,
    preamble: null,
    turns: [],
  };
  if (segments.preamble !== null && selection.includePreamble) {
    const events = filterEvents(segments.preamble.events, selection.sections);
    if (events.length > 0) doc.preamble = { eventCount: events.length, events };
  }
  for (const turn of segments.turns) {
    if (!selected.has(turn.turn)) continue;
    const events = filterEvents(turn.events, selection.sections);
    doc.turns.push({
      turn: turn.turn,
      startSeq: turn.seq,
      endSeq: turn.events[turn.events.length - 1]?.seq ?? turn.seq,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      endReason: turn.endReason,
      open: turn.open,
      eventCount: events.length,
      events,
    });
  }
  return doc;
}

/**
 * Build the format-agnostic view document consumed by the md and html renderers.
 * @param input - plan, segmentation, selection, and generation time.
 * @returns `{ doc, selection }` where `selection.turns` is always explicit.
 */
export function buildViewDocument(input) {
  const { plan, segments, selection, generatedAt } = input;
  const selectedTurns = selection.turns === null ? segments.turns.map((turn) => turn.turn) : selection.turns;
  const selected = new Set(selectedTurns);
  const callNames = new Map();
  if (segments.preamble !== null) for (const event of segments.preamble.events) rememberCallNames(event, callNames);
  for (const turn of segments.turns) for (const event of turn.events) rememberCallNames(event, callNames);
  const turns = [];
  for (const turn of segments.turns) {
    if (!selected.has(turn.turn)) continue;
    const blocks = buildBlocks(turn.events, selection.sections, selection.maxToolResultChars, callNames);
    if (blocks.length === 0) continue;
    turns.push({
      turn: turn.turn,
      seq: turn.seq,
      startSeq: turn.seq,
      endSeq: turn.events[turn.events.length - 1]?.seq ?? turn.seq,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      endReason: turn.endReason,
      open: turn.open,
      blocks,
    });
  }
  let preamble = null;
  if (segments.preamble !== null && selection.includePreamble) {
    const blocks = buildBlocks(segments.preamble.events, selection.sections, selection.maxToolResultChars, callNames);
    if (blocks.length > 0) preamble = { blocks };
  }
  return {
    doc: {
      kind: 'view',
      generatedAt,
      generator: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      language: selection.language,
      session: plan.session,
      selection: {
        turns: selectedTurns,
        allTurns: selection.turns === null,
        includePreamble: selection.includePreamble,
        sections: selection.sections,
        maxToolResultChars: selection.maxToolResultChars,
        collapseThinking: selection.collapseThinking,
      },
      summary: {
        turnTotal: segments.turns.length,
        turnSelected: selectedTurns.length,
        turnRendered: turns.length,
        turnsSkipped: selectedTurns.length - turns.length,
        preambleRendered: preamble !== null,
      },
      preamble,
      turns,
    },
  };
}
