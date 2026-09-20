/**
 * Job-id extraction for the communication flow.
 *
 * Extracted from `chat-reader.ts` so the rule that turns raw DOM hints (hrefs
 * and `data-*id` attributes) into job ids is unit-testable without a DOM, and so
 * there is exactly ONE place where the answer to "does this string identify a
 * job?" is decided.
 *
 * ============================ HONESTY NOTICE ============================
 * The shapes below are guesses about BOSS URLs and data attributes. The real
 * site was never inspected. See `selectors.ts` for the confidence markers.
 * =======================================================================
 */

import { normalizeText } from "./selectors";

/**
 * Patterns that pull a job id out of a raw hint.
 *
 * `job_detail/<id>` is the documented-looking BOSS detail path; the query-string
 * variants are belt-and-braces. Both are heuristic.
 */
const JOB_ID_PATTERNS: readonly RegExp[] = [
  /job_detail\/([A-Za-z0-9_-]+)/i,
  /[?&](?:jobId|job_id|jid|jobid)=([A-Za-z0-9_-]+)/i,
];

/**
 * Extracts the distinct job ids implied by a set of raw hints.
 *
 * A hint counts as an id outright when it is purely numeric (the shape of a
 * `data-job-id` value); otherwise the patterns above are tried and their
 * captured groups are kept.
 *
 * Failure mode: returns `[]` when nothing in the input looks like an id. It
 * never invents an id, never truncates an arbitrary token into one, and never
 * returns a partial match — an empty list makes `matchChatIdentity` fall back to
 * text comparison, which is weaker but honest. Order is preserved and duplicates
 * are dropped, so callers can rely on deterministic output.
 */
export const extractJobIds = (hints: readonly string[]): readonly string[] => {
  const ids: string[] = [];
  const push = (value: string): void => {
    const trimmed = normalizeText(value);
    if (trimmed.length === 0) return;
    if (!ids.includes(trimmed)) ids.push(trimmed);
  };

  for (const hint of hints) {
    const trimmed = normalizeText(hint);
    if (trimmed.length === 0) continue;
    if (/^\d+$/.test(trimmed)) {
      push(trimmed);
      continue;
    }
    for (const pattern of JOB_ID_PATTERNS) {
      const captured = pattern.exec(trimmed)?.[1];
      if (captured !== undefined) push(captured);
    }
  }
  return ids;
};

/**
 * Reports whether a string is a legal job id for identity comparison.
 *
 * Used to validate ids READ OFF THE DOM before they are trusted. The point is to
 * reject the containers the fixture sets `data-job-id` on: a value like
 * `job-12345` or `12345` is an id, while a sentence, a selector fragment or an
 * empty string is not.
 *
 * Failure mode: returns `false` for anything containing whitespace or characters
 * outside `[A-Za-z0-9_-]`, or longer than 64 characters. A false negative merely
 * weakens identity evidence (the text comparison still runs); a false positive
 * could match the WRONG job, so the bias is towards rejecting.
 */
export const isPlausibleJobId = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(trimmed);
};
