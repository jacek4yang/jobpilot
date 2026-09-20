/**
 * Diagnostic redaction.
 *
 * Redaction happens at WRITE time, in the recorder, not at export time. A value
 * that never enters a buffer cannot leak through a future export path, a new
 * bundle file, or a bug in the exporter. Export-time redaction is a single
 * point of failure; write-time redaction is defence in depth.
 *
 * This module extends the logger's redaction with the categories the brief
 * calls out explicitly: chat content, drafts, resume text and full HTML.
 */
import { redact as redactBase } from "../ports/logger";

/** Substrings that mark a string as too sensitive to record verbatim. */
export const SENSITIVE_MARKERS: readonly string[] = [
  "cookie",
  "authorization",
  "bearer ",
  "token",
  "password",
  "passwd",
  "secret",
  "sessionid",
  "session_id",
  "csrf",
  "resume",
  "简历",
  "身份证",
];

/**
 * Field names whose values are replaced with a length and a hash.
 *
 * Exact names alone are not enough: a caller can reasonably write `userDraft`,
 * `privateChat` or `chatHistory`, and an exact-match list would let those
 * through in the clear. The patterns below are matched on normalized
 * substrings, so a new name containing any sensitive concept still redacts
 * without anyone having to remember to update a list.
 */
export const HASHED_FIELD_PATTERNS: readonly string[] = [
  "messagebody",
  "messagecontent",
  "messagetext",
  "chatcontent",
  "chattext",
  "chathistory",
  "conversationtext",
  "conversationcontent",
  "privatemsg",
  "privatemessage",
  "privatechat",
  "recruitermessage",
  "drafttext",
  "draftcontent",
  "userdraft",
  "draft",
  "resumetext",
  "resumecontent",
  "html",
  "outerhtml",
  "innerhtml",
  "pagehtml",
];

/** Retained for compatibility with callers that reference the old list. */
export const HASHED_FIELDS: readonly string[] = HASHED_FIELD_PATTERNS;

const REDACTED = "[redacted]";

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, "");

const matchesAny = (key: string, needles: readonly string[]): boolean => {
  const normalised = normaliseKey(key);
  return needles.some((needle) => normalised.includes(normaliseKey(needle)));
};

/**
 * A stable, non-reversible digest for a string.
 *
 * FNV-1a is used rather than SHA-256 because this runs synchronously on hot
 * paths inside a content script, and the requirement here is change detection —
 * not cryptographic strength. Anything needing a true digest (the bundle
 * manifest) uses SHA-256 from the dedicated hashing module.
 */
export const fingerprintText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
};

export interface TextFingerprint {
  readonly length: number;
  readonly sha256OrFnv: string;
  /** First few characters, only when the caller has marked text as safe. */
  readonly preview?: string;
}

/**
 * Reduces text to a safe summary.
 *
 * `safe` must be set deliberately by the caller — it is for text JobPilot
 * itself generated or for structural page labels, never for user content.
 */
export const fingerprint = (
  value: string,
  options: { readonly safe?: boolean; readonly previewChars?: number } = {},
): TextFingerprint => {
  const base: { length: number; sha256OrFnv: string; preview?: string } = {
    length: value.length,
    sha256OrFnv: fingerprintText(value),
  };
  if (options.safe === true && options.previewChars !== undefined && options.previewChars > 0) {
    return { ...base, preview: normaliseWhitespace(value).slice(0, options.previewChars) };
  }
  return base;
};

export const normaliseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Redacts a value destined for a diagnostic event.
 *
 * Order of operations matters:
 *  1. known-sensitive keys are dropped outright;
 *  2. content-bearing keys are replaced by a fingerprint;
 *  3. strings are scanned for credential shapes (bearer tokens, query tokens);
 *  4. everything else falls through to the base logger's redaction.
 */
export const redactDiagnostic = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) {
    // Bounded: a diagnostic event carrying a 10 000-element array is a bug in
    // the caller, not evidence.
    return value.slice(0, 50).map((item) => redactDiagnostic(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (
        matchesAny(key, ["cookie", "token", "password", "secret", "credential", "authorization"])
      ) {
        output[key] = REDACTED;
        continue;
      }
      if (matchesAny(key, HASHED_FIELD_PATTERNS) && typeof nested === "string") {
        output[key] = fingerprint(nested);
        continue;
      }
      output[key] = redactDiagnostic(nested, depth + 1);
    }
    return output;
  }
  return "[unserializable]";
};

/** Removes credential shapes from a string while keeping it readable. */
export const redactString = (value: string): string => {
  const lowered = value.toLowerCase();
  // A string that merely MENTIONS a sensitive word is not itself sensitive, but
  // a string containing an assignment or a bearer token is.
  const scrubbed = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED)
    .replace(
      /\b(token|sessionid|session_id|password|authorization|csrf)=[^;\s&]+/gi,
      `$1=${REDACTED}`,
    )
    .replace(/\b\d{15,18}\b/g, "[id-number]");

  if (SENSITIVE_MARKERS.some((marker) => lowered.includes(marker) && scrubbed === value)) {
    // The string mentions a sensitive concept but no pattern matched. Record it
    // as a fingerprint instead of risking a leak we did not anticipate.
    return `[redacted:${fingerprintText(value)}]`;
  }
  return scrubbed;
};

/** Applies the base logger's redaction as a final pass. */
export const redactForBundle = (value: unknown): unknown => redactBase(redactDiagnostic(value));

export { REDACTED };
