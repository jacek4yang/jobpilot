/**
 * BOSS Zhipin job-list parser.
 *
 * ============================ HONESTY NOTICE ============================
 * This parser was written blind: the real BOSS Zhipin list markup was never
 * inspected. It is validated ONLY against the synthetic fixture
 * `tests/fixtures/boss/job-list.html`, which was authored to match
 * `selectors.ts`. Real-site list parsing is UNVERIFIED.
 * =======================================================================
 *
 * Contract:
 *   - Read-only. This file performs no DOM writes, ever.
 *   - Total. Unparsable cards are skipped, never thrown on, so one bad card
 *     cannot abort a scan.
 *   - Honest. A card with no platform id gets a deterministic fingerprint and
 *     `idIsPlatformNative: false`; it is never given a fabricated native id.
 */

import { canonicalizeUrl, fingerprintJob, type JobSummary } from "../../../domain/job/job";
import { asPlatformId } from "../../../domain/support/ids";
import { queryFirst, SELECTORS } from "../selectors";

/** Attribute names that may carry a platform-native job id, in priority order. */
export const JOB_ID_ATTRIBUTES: readonly string[] = SELECTORS.list.jobIdAttribute.candidates;

/**
 * Result of a list scan.
 *
 * `skipped` is reported rather than logged-and-forgotten so callers can decide
 * whether a partially-parsed page is trustworthy (see `parseConfidence`).
 */
export interface JobListParseResult {
  readonly jobs: readonly JobSummary[];
  readonly skipped: number;
  /** Total cards seen, parsed + skipped. */
  readonly considered: number;
}

/** Normalises whitespace so equality checks and fingerprints are stable. */
const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/** Non-empty text of the first matching selector, or `undefined`. */
const textOf = (root: ParentNode, candidates: readonly string[]): string | undefined => {
  for (const candidate of candidates) {
    let element: Element | null = null;
    try {
      element = root.querySelector(candidate);
    } catch {
      continue;
    }
    if (element !== null) {
      const text = clean(element.textContent);
      if (text.length > 0) return text;
    }
  }
  return undefined;
};

/** Resolves an `href` attribute against the document origin when possible. */
const readHref = (root: ParentNode): string | undefined => {
  const located = queryFirst(root, SELECTORS.list.link);
  if (located === null) return undefined;
  const href = located.element.getAttribute("href");
  if (href === null) return undefined;
  const trimmed = href.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Finds the platform-native job id on a card.
 *
 * Failure mode: returns `undefined` when no known attribute is present. Callers
 * then fall back to `fingerprintJob`; they must NOT invent an id from the DOM
 * position, which would change between reloads.
 */
export const readPlatformJobId = (card: Element): string | undefined => {
  for (const attribute of JOB_ID_ATTRIBUTES) {
    const value = card.getAttribute(attribute);
    if (value !== null) {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  // Fall back to an id embedded in the detail link's query string.
  const href = readHref(card);
  if (href === undefined) return undefined;
  const match = /[?&](?:jobId|job_id|jid)=([^&#]+)/i.exec(href);
  const captured = match?.[1];
  if (captured === undefined) return undefined;
  const decoded = clean(decodeURIComponent(captured));
  return decoded.length > 0 ? decoded : undefined;
};

/** Best-effort absolute URL for a detail link, with tracking params dropped. */
const readCanonicalUrl = (
  raw: string | undefined,
  baseHref: string | undefined,
): string | undefined => {
  if (raw === undefined) return undefined;
  if (baseHref === undefined) return canonicalizeUrl(raw);
  try {
    return canonicalizeUrl(new URL(raw, baseHref).toString());
  } catch {
    return canonicalizeUrl(raw);
  }
};

/**
 * Parses exactly one card.
 *
 * Failure mode: returns `null` when the card lacks a title, a company name, or
 * both an id and the fields needed to fingerprint it. Never throws and never
 * fills a missing field with a placeholder.
 */
export const parseBossJobCard = (
  card: Element,
  platformId: string,
  baseHref: string | undefined,
): JobSummary | null => {
  const title = textOf(card, SELECTORS.list.title.candidates);
  const companyName = textOf(card, SELECTORS.list.company.candidates);
  if (title === undefined || companyName === undefined) return null;

  const locationRaw = textOf(card, SELECTORS.list.location.candidates) ?? "";
  const salaryRaw = textOf(card, SELECTORS.list.salary.candidates) ?? "";
  const platform = asPlatformId(platformId);
  const url = readCanonicalUrl(readHref(card), baseHref);
  const nativeId = readPlatformJobId(card);

  const id =
    nativeId === undefined
      ? fingerprintJob({
          platform,
          companyName,
          title,
          locationRaw,
          ...(url === undefined ? {} : { canonicalUrl: url }),
        })
      : fingerprintJob({
          // Deliberately still fingerprinted so the id is namespaced and stable,
          // but recorded as platform-native below.
          platform,
          companyName,
          title,
          locationRaw,
          canonicalUrl: url ?? nativeId,
        });

  return {
    id,
    platform,
    title,
    companyName,
    locationRaw,
    salaryRaw,
    ...(url === undefined ? {} : { url }),
    idIsPlatformNative: nativeId !== undefined,
  };
};

export interface JobListParseOptions {
  /**
   * Absolute URL of the page the cards were read from.
   *
   * Relative hrefs are resolved against it so that the same posting always
   * fingerprints to the same id. When omitted we fall back to the root's own
   * `ownerDocument.location`, and when that is unavailable the href stays
   * relative — which is a known source of split identities, so the production
   * adapter always passes this explicitly.
   */
  readonly baseHref?: string;
}

/**
 * Parses every job card under `root`.
 *
 * Failure mode: returns an empty `jobs` array with a populated `skipped` count
 * when nothing is parsable. It does not throw, does not mutate the DOM and does
 * not halt on the first bad card.
 */
export const parseBossJobList = (
  root: ParentNode,
  platformId: string,
  options: JobListParseOptions = {},
): JobListParseResult => {
  const cards = resolveCards(root);
  const baseHref = options.baseHref ?? readBaseHref(root);

  const jobs: JobSummary[] = [];
  let skipped = 0;

  for (const card of cards) {
    const parsed = parseBossJobCard(card, platformId, baseHref);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    jobs.push(parsed);
  }

  return { jobs, skipped, considered: cards.length };
};

/** Resolves card elements, preferring the first candidate that matches. */
const resolveCards = (root: ParentNode): readonly Element[] => {
  for (const candidate of SELECTORS.list.card.candidates) {
    try {
      const found = Array.from(root.querySelectorAll(candidate));
      if (found.length > 0) return found;
    } catch {}
  }
  return [];
};

/**
 * Document base URL used to absolutise relative hrefs, when available.
 *
 * Failure mode: returns `undefined` when no base can be determined, which makes
 * card URLs fall back to `canonicalizeUrl`'s relative handling rather than
 * inventing an origin. Deliberately duck-typed via `ownerDocument` instead of
 * `instanceof Document`, because the global `Document` constructor is not
 * guaranteed to exist in non-browser test environments.
 */
const readBaseHref = (root: ParentNode): string | undefined => {
  const ownerDocument: Document | null = root.ownerDocument;
  if (ownerDocument === null) return undefined;
  const href: string | undefined = ownerDocument.location?.href;
  return href !== undefined && href.length > 0 ? href : undefined;
};
