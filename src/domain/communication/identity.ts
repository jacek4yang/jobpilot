/**
 * Conversation identity matching.
 *
 * Sending into the wrong conversation is a privacy failure, not a glitch. This
 * module decides whether an observed conversation corresponds to the job we
 * intend to contact, using the strongest available evidence and a documented
 * precedence order:
 *
 *   job id  >  title + (company | recruiter)
 *
 * It is pure: callers extract plain strings from the DOM and pass them in, so
 * the matching logic is unit-testable without a browser and cannot accidentally
 * depend on layout.
 */

/** Identity of the job we intend to contact. */
export interface JobIdentity {
  readonly jobId?: string;
  readonly title?: string;
  readonly company?: string;
  readonly recruiter?: string;
}

/** Identity observed in a candidate conversation. */
export interface ChatIdentity {
  /** Job ids found anywhere in the conversation region. */
  readonly jobIds: readonly string[];
  /** Source-ranked ids. When present, only the strongest level may decide. */
  readonly jobIdEvidence?: readonly JobIdEvidence[];
  /** Normalised-ish free text of the conversation header plus visible job info. */
  readonly text: string;
}

export type JobIdStrength = "fallback" | "page-data" | "canonical-url" | "platform";

export interface JobIdEvidence {
  readonly id: string;
  readonly strength: JobIdStrength;
}

export type IdentityVerdict =
  | { readonly kind: "match"; readonly evidence: string[] }
  | { readonly kind: "mismatch"; readonly reason: string }
  | { readonly kind: "insufficient"; readonly reason: string };

/**
 * Company legal-form suffixes, longest first.
 *
 * Order matters. `股份有限公司` must be tried before `有限公司`, otherwise
 * stripping `有限公司` from `示例股份有限公司` leaves the dangling `股份`,
 * and the same company would normalise two different ways depending on which
 * legal form is displayed.
 */
const COMPANY_SUFFIXES: readonly string[] = ["股份有限公司", "有限责任公司", "有限公司"];

/**
 * Normalises text for identity comparison.
 *
 * Strips whitespace, the separators BOSS uses between fields, and a trailing
 * company legal-form suffix. This mirrors the normalisation the reference
 * implementation independently arrived at, which is a good sign that it is the
 * right set.
 */
export const normalizeIdentityText = (value: string | undefined): string => {
  if (value === undefined) return "";
  let text = value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·•\-—_（）()【】[\]]/g, "");

  // Strip at most one legal-form suffix, longest match first.
  for (const suffix of COMPANY_SUFFIXES) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, text.length - suffix.length);
      break;
    }
  }

  return text;
};

/** True when `needle` appears in `haystack` after normalisation. */
const containsNormalized = (haystack: string, needle: string): boolean => {
  const normalizedNeedle = normalizeIdentityText(needle);
  if (normalizedNeedle.length === 0) return false;
  return normalizeIdentityText(haystack).includes(normalizedNeedle);
};

export interface MatchOptions {
  /**
   * When true, a job-id comparison is treated as authoritative: if both sides
   * have ids and they do not intersect, the verdict is `mismatch` regardless of
   * text similarity.
   */
  readonly requireJobIdMatch?: boolean;
}

/**
 * Decides whether a conversation matches the intended job.
 *
 * Conservative by construction:
 * - Contradictory job ids are an immediate mismatch, even if the text matches.
 *   Two different postings at the same company must not be conflated.
 * - Without a usable job id, a title match alone is not enough; the company or
 *   recruiter must corroborate it.
 * - Missing evidence yields `insufficient`, never `match`. The caller must wait
 *   for more evidence or fail closed.
 */
export const matchChatIdentity = (
  job: JobIdentity,
  chat: ChatIdentity,
  options: MatchOptions = {},
): IdentityVerdict => {
  const evidence: string[] = [];

  const jobId = job.jobId?.trim();
  const ranked =
    chat.jobIdEvidence ?? chat.jobIds.map((id) => ({ id, strength: "page-data" as const }));
  const strengthRank: Readonly<Record<JobIdStrength, number>> = {
    fallback: 0,
    "page-data": 1,
    "canonical-url": 2,
    platform: 3,
  };
  const highestRank = ranked.reduce(
    (highest, item) => Math.max(highest, strengthRank[item.strength]),
    -1,
  );
  const strongestIds = [
    ...new Set(
      ranked.filter((item) => strengthRank[item.strength] === highestRank).map((item) => item.id),
    ),
  ];
  const comparableIds = jobId !== undefined && jobId.length > 0 && strongestIds.length > 0;

  if (comparableIds) {
    const ids = strongestIds;
    if (ids.length === 1 && ids[0] === jobId) {
      evidence.push(`job id ${jobId} found in conversation`);
    } else {
      return {
        kind: "mismatch",
        reason: `conversation carries job id(s) [${ids.join(", ")}] but we expected ${jobId}`,
      };
    }
  }

  const titleMatches = job.title !== undefined && containsNormalized(chat.text, job.title);
  const companyMatches = job.company !== undefined && containsNormalized(chat.text, job.company);
  const recruiterMatches =
    job.recruiter !== undefined && containsNormalized(chat.text, job.recruiter);

  if (titleMatches) evidence.push("job title found in conversation");
  if (companyMatches) evidence.push("company found in conversation");
  if (recruiterMatches) evidence.push("recruiter found in conversation");

  // A confirmed job-id match is authoritative: we already returned `mismatch`
  // above if the ids failed to intersect, so reaching here means the id agreed.
  // Corroborating text is recorded as evidence but is not required, because
  // BOSS chat headers do not always repeat the job title.
  if (comparableIds) {
    return { kind: "match", evidence };
  }

  if (options.requireJobIdMatch === true) {
    return {
      kind: "insufficient",
      reason: "job id match required but the conversation exposes no job id",
    };
  }

  // No ids available on one side: require a title plus corroboration.
  if (!titleMatches) {
    return {
      kind: "insufficient",
      reason: "job title not found in the conversation, and no job id was available to compare",
    };
  }
  if (companyMatches || recruiterMatches) return { kind: "match", evidence };

  return {
    kind: "insufficient",
    reason: "job title matched but neither company nor recruiter corroborated it",
  };
};

/**
 * Detects a conversation switch between two observations.
 *
 * Used to abort a transaction when the user (or the SPA) moves the chat
 * underneath an in-flight action.
 */
export const isSameConversation = (previous: ChatIdentity, current: ChatIdentity): boolean => {
  const sameIds =
    previous.jobIds.length === 0 ||
    current.jobIds.length === 0 ||
    previous.jobIds.some((id) => current.jobIds.includes(id));
  if (!sameIds) return false;
  return normalizeIdentityText(previous.text) === normalizeIdentityText(current.text);
};

/**
 * Counts outgoing messages whose body equals `text`.
 *
 * This is the success signal for a send. The caller supplies already-extracted
 * message bodies rather than DOM nodes, keeping the counting rule testable.
 * Whitespace is normalised because rich editors introduce insignificant
 * differences between the text we inserted and the text that renders.
 *
 * Messages that failed to send must be excluded by the caller before calling
 * this, which is why this function takes plain strings.
 */
export const countOutgoingMessages = (outgoingBodies: readonly string[], text: string): number => {
  const expected = normalizeMessageText(text);
  if (expected.length === 0) return 0;
  return outgoingBodies.filter((body) => normalizeMessageText(body) === expected).length;
};

/** Normalises message text for equality comparison. */
export const normalizeMessageText = (value: string | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();
