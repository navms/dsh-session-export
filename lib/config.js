/**
 * Constants, default export policy, and defensive configuration normalization.
 *
 * This module is intentionally dependency-free: the plugin declares no
 * runtime dependencies at all, so it can be installed by symlinking its
 * directory into a profile's `node_modules` without depending on Node's
 * realpath-based upward `node_modules` lookup.
 *
 * @module dsh-session-export/config
 */

/** Stable plugin package name; also the browser bundle id and the Loader row name. */
export const PLUGIN_NAME = 'dsh-session-export';

/** Plugin version embedded in exported artifacts. */
export const PLUGIN_VERSION = '0.1.0';

/** Browser-addressable plan route (the shared API channel strips the leading slash). */
export const PLAN_PATH = '/api/session.transcript.plan';

/** Browser-addressable render route. */
export const RENDER_PATH = '/api/session.transcript';

/** Accepted export formats, in menu order. */
export const EXPORT_FORMATS = ['md', 'html', 'json'];

/**
 * Selectable event sections in presentation order.
 *
 * The renderers and the browser picker share this order through the plan
 * response's `sectionOrder`, so the vocabulary lives in exactly one place.
 */
export const SECTION_ORDER = [
  'user',
  'context',
  'assistant',
  'thinking',
  'toolCalls',
  'toolResults',
  'images',
  'files',
  'usage',
  'markers',
  'attempts',
  'stream',
  'other',
];

/**
 * Default section selection: a clean conversation transcript.
 *
 * Only the two message roles are on — the human prompts and the model's
 * replies. Reasoning, tool traffic, attachments, injected context, lifecycle
 * markers, failed attempts, raw streams, and unclassified events are all off:
 * they either dominate the byte count or answer a question the default reader
 * did not ask. Each one is a single click away in the dialog, and a deployment
 * can restate any subset through the row's `config.defaultSections`.
 */
export const DEFAULT_SECTIONS = {
  user: true,
  context: false,
  assistant: true,
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
};

/** Hard limits the request layer clamps user input against. */
export const LIMITS = {
  maxTurns: 2000,
  maxToolResultChars: 20000,
  maxOutputBytes: 33554432,
  maxEmbeddedImageBytes: 8388608,
  /** Bounds on the client-supplied per-artifact option; not part of LIMITS-by-config. */
  minToolResultChars: 200,
  maxToolResultCharsCeiling: 2000000,
};

/** Smallest and largest accepted `maxToolResultChars`. */
export const TOOL_RESULT_CHARS_FLOOR = LIMITS.minToolResultChars;

/** Largest accepted `maxToolResultChars`. */
export const TOOL_RESULT_CHARS_CEILING = LIMITS.maxToolResultCharsCeiling;

/** Longest accepted session id in a request. */
export const MAX_SESSION_ID_LENGTH = 200;

/**
 * Coerce one unknown value to a finite number inside a range.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is not a finite number.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped number.
 */
export function clampNumber(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/**
 * Normalize one boolean-ish candidate.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is not a boolean.
 * @returns the boolean.
 */
export function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Read one plain-object member defensively.
 * @param value - candidate container.
 * @returns the container when it is a non-array object, otherwise an empty object.
 */
export function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * Build a complete boolean section map from a partial candidate.
 * @param candidate - partial (or absent) section map.
 * @param defaults - base map whose keys define the vocabulary.
 * @returns a new map with every key of `defaults` present.
 */
export function mergeSections(candidate, defaults) {
  const source = asRecord(candidate);
  const merged = {};
  for (const key of Object.keys(defaults)) {
    merged[key] = asBoolean(source[key], defaults[key]);
  }
  return merged;
}

/**
 * Normalize the Loader row's `config:` block.
 *
 * The plugin intentionally exports no Schemastery `Config`, so Cordis passes
 * the raw YAML value through unchanged; every field is validated here instead.
 * Unknown keys are ignored and invalid values fall back to defaults.
 * @param raw - the raw row configuration, if any.
 * @returns the resolved plugin configuration.
 */
export function normalizeConfig(raw) {
  const source = asRecord(raw);
  return {
    maxTurns: clampNumber(source.maxTurns, LIMITS.maxTurns, 1, 100000),
    maxToolResultChars: clampNumber(
      source.maxToolResultChars,
      LIMITS.maxToolResultChars,
      TOOL_RESULT_CHARS_FLOOR,
      TOOL_RESULT_CHARS_CEILING,
    ),
    maxOutputBytes: clampNumber(source.maxOutputBytes, LIMITS.maxOutputBytes, 65536, 536870912),
    maxEmbeddedImageBytes: clampNumber(
      source.maxEmbeddedImageBytes,
      LIMITS.maxEmbeddedImageBytes,
      0,
      134217728,
    ),
    defaultSections: mergeSections(source.defaultSections, DEFAULT_SECTIONS),
  };
}

/** Extension for every accepted export format. */
export const FORMAT_EXTENSIONS = {
  md: 'md',
  html: 'html',
  json: 'json',
};

/** Response content type for every accepted export format. */
export const FORMAT_CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
};
