/**
 * BOSS Zhipin selector registry — the single source of truth for every DOM
 * query the BOSS adapter performs.
 *
 * ============================ HONESTY NOTICE ============================
 * The real BOSS Zhipin DOM was NOT inspected while writing this file. Roughly
 * one in three entries below is therefore a *guess* about the live site.
 *
 * Every entry carries an explicit `confidence` field:
 *   - "fixture-only" — asserted by the synthetic fixtures under
 *     `tests/fixtures/boss/`, which were authored to match this file. Matching
 *     a fixture proves the parser plumbing works; it says NOTHING about the
 *     real site.
 *   - "unverified"   — a heuristic guess about real BOSS markup. It may match
 *     nothing, or match the wrong element, on the live site.
 *
 * Consequently `BOSS_METADATA.automationVerified` is `false` and must remain so
 * until someone validates these selectors against the real site and updates
 * this table with evidence. Do not promote an entry to "verified" without that
 * evidence.
 *
 * Candidates are ordered by robustness: semantic attributes (itemprop, role,
 * data-*) first, then ARIA, then stable structure, then stable class names,
 * and only then a limited text fallback. `queryFirst` walks them in order and
 * reports which one won, so diagnostics can tell a stable anchor from a guess.
 * =======================================================================
 */

import type { LocatedElement } from "../../ports/job-platform";

/**
 * Confidence in a selector.
 *
 * `"fixture-only"` is deliberately NOT called "verified": it only asserts
 * agreement with our own synthetic fixture, never with the real site.
 */
export type SelectorConfidence = "fixture-only" | "unverified";

/** One logical DOM target, with an ordered list of ways to find it. */
export interface SelectorEntry {
  /** Tried in order; the first match wins. Never empty. */
  readonly candidates: readonly string[];
  readonly confidence: SelectorConfidence;
  /** Why these candidates, in what order, and what is unknown about them. */
  readonly note: string;
}

/** Shorthand: all candidates in the group share one confidence and note. */
export interface SelectorGroup {
  readonly candidates: readonly string[];
  readonly confidence: SelectorConfidence;
  readonly note: string;
}

/** Keys of the `list` selector group. Enumerated so helpers stay type-safe. */
export type ListSelectorKey =
  | "card"
  | "link"
  | "title"
  | "company"
  | "salary"
  | "location"
  | "jobIdAttribute"
  | "tags";

/** Keys of the `detail` selector group. */
export type DetailSelectorKey =
  | "root"
  | "title"
  | "salary"
  | "location"
  | "companyName"
  | "companyMeta"
  | "tags"
  | "description"
  | "requirements"
  | "skills"
  | "recruiterName"
  | "recruiterTitle"
  | "applyButton"
  | "alreadyAppliedMarker"
  | "applySuccessMarker"
  | "applyDialog"
  | "applyDialogSubmit";

/** Keys of the `guards` selector group (fail-closed detection anchors). */
export type GuardSelectorKey =
  | "captcha"
  | "riskControl"
  | "loginRequired"
  | "loginForm"
  | "emptyResult"
  | "jobDetailRoot"
  | "jobListRoot";

/** Machine-readable annotation attached to every selector for diagnostics. */
export interface SelectorProvenance {
  readonly confidence: SelectorConfidence;
  readonly note: string;
}

const FIXTURE_ONLY = "fixture-only" as const;
const UNVERIFIED = "unverified" as const;

/**
 * One shared candidate list reused by several targets in a group.
 * Kept as named constants so the note explaining the ordering is written once.
 */
const CARD_CANDIDATES: readonly string[] = [
  // Semantic author hooks the fixture sets explicitly.
  "[data-jobpilot-card]",
  // `itemprop` from schema.org JobPosting microdata — real sites often emit it.
  "[itemprop='jobPosting']",
  // Structural fallbacks scoped to the fixture list container.
  "ul.job-list > li.job-card",
  "li.job-card",
];

/**
 * Every BOSS selector, grouped by concern.
 *
 * `guards` entries are intentionally over-broad (they match on visible text as
 * a last resort) because a false positive only pauses automation, whereas a
 * false negative could let automation click through a CAPTCHA. Fail closed.
 */
export const SELECTORS = {
  list: {
    card: {
      candidates: CARD_CANDIDATES,
      confidence: FIXTURE_ONLY,
      note: "Fixture defines data-jobpilot-card on every card. The itemprop and class candidates are shape guesses about real BOSS markup and may match nothing or too much.",
    },
    link: {
      candidates: [
        "a.job-card__link[href]",
        "[data-jobpilot-link][href]",
        "a[href*='/job_detail/']",
      ],
      confidence: FIXTURE_ONLY,
      note: "Fixture uses a.job-card__link. The href substring is a durable-looking real-site guess but is unverified.",
    },
    title: {
      candidates: ["[itemprop='title']", "[data-jobpilot-field='title']", "h3.job-card__title"],
      confidence: FIXTURE_ONLY,
      note: "itemprop first because schema.org microdata is the most stable author signal. The class candidate is fixture-shaped.",
    },
    company: {
      candidates: [
        "[itemprop='hiringOrganization'] [itemprop='name']",
        "[data-jobpilot-field='company']",
        ".job-card__company",
      ],
      confidence: FIXTURE_ONLY,
      note: "Nested itemprop mirrors real JobPosting microdata shape. Unverified on the live site.",
    },
    salary: {
      candidates: [
        "[itemprop='baseSalary']",
        "[data-jobpilot-field='salary']",
        ".job-card__salary",
      ],
      confidence: FIXTURE_ONLY,
      note: "Salary is display-only here: it is always re-parsed through parseSalary, which fails soft.",
    },
    location: {
      candidates: [
        "[itemprop='jobLocation']",
        "[data-jobpilot-field='location']",
        ".job-card__location",
      ],
      confidence: FIXTURE_ONLY,
      note: "Feeds parseLocation. An empty match yields an unknown city rather than a wrong one.",
    },
    jobIdAttribute: {
      candidates: ["data-job-id", "data-jobid", "data-jid"],
      confidence: FIXTURE_ONLY,
      note: "Attribute names, not selectors. The first attribute present on the card wins; if none is present the id falls back to fingerprintJob and idIsPlatformNative stays false.",
    },
    tags: {
      candidates: ["[data-jobpilot-field='tags'] .job-card__tag", ".job-card__tags .job-card__tag"],
      confidence: UNVERIFIED,
      note: "Purely heuristic. Tag text on real BOSS cards is not a documented contract; consumers must treat it as advisory.",
    },
  },
  detail: {
    root: {
      candidates: [
        "[data-jobpilot-detail]",
        "[itemtype='https://schema.org/JobPosting']",
        "main.job-detail",
      ],
      confidence: FIXTURE_ONLY,
      note: "Presence of this root is one of the two positive requirements for classifyJobDetail.",
    },
    title: {
      candidates: ["[itemprop='title']", "h1.job-detail__title"],
      confidence: FIXTURE_ONLY,
      note: "Required anchor: parseBossJobDetail returns null when absent, so a missing title blocks rather than guesses.",
    },
    salary: {
      candidates: ["[itemprop='baseSalary']", ".job-detail__salary"],
      confidence: FIXTURE_ONLY,
      note: "Optional: absence yields salary.parsed === false, which rules treat as 'do not hard-reject'.",
    },
    location: {
      candidates: ["[itemprop='jobLocation']", ".job-detail__location"],
      confidence: FIXTURE_ONLY,
      note: "Optional. parseLocation is total, so there is no failure path here.",
    },
    companyName: {
      candidates: [
        "[itemprop='hiringOrganization'] [itemprop='name']",
        ".job-detail__company-name",
      ],
      confidence: FIXTURE_ONLY,
      note: "Required anchor: without a company name the detail is rejected as unparsable.",
    },
    companyMeta: {
      candidates: [
        "[data-jobpilot-field='company-meta']",
        ".job-detail__company-meta .job-detail__meta-item",
      ],
      confidence: UNVERIFIED,
      note: "Heuristic. Real BOSS company meta (industry/stage/size) markup is unknown; each item's text is matched against coarse Chinese keyword tables.",
    },
    tags: {
      candidates: ["[data-jobpilot-field='job-tags'] .job-detail__tag", ".job-detail__tags span"],
      confidence: FIXTURE_ONLY,
      note: "Holds the education/experience chips that map onto the domain unions.",
    },
    description: {
      candidates: ["[data-jobpilot-field='description']", ".job-detail__description"],
      confidence: FIXTURE_ONLY,
      note: "Optional; falls back to an empty string, never to a fabricated summary.",
    },
    requirements: {
      candidates: ["[data-jobpilot-field='requirements'] li", ".job-detail__requirements li"],
      confidence: UNVERIFIED,
      note: "Heuristic. Returns a multi-element list, so it is read with queryAllFirst rather than queryFirst.",
    },
    skills: {
      candidates: ["[data-jobpilot-field='skills'] .job-detail__skill", ".job-detail__skills span"],
      confidence: UNVERIFIED,
      note: "Heuristic keyword chips on the real site are not a documented contract; consumers treat them as advisory hints.",
    },
    recruiterName: {
      candidates: ["[data-jobpilot-field='recruiter']", ".job-detail__recruiter-name"],
      confidence: UNVERIFIED,
      note: "Heuristic. Absence simply yields no recruiter, which the headhunter rule treats as 'no headhunter detected'.",
    },
    recruiterTitle: {
      candidates: ["[data-jobpilot-field='recruiter-title']", ".job-detail__recruiter-title"],
      confidence: UNVERIFIED,
      note: "Heuristic. Used only for display and the 猎头 substring check.",
    },
    applyButton: {
      candidates: [
        "button[data-jobpilot-action='apply']",
        "[role='button'][data-jobpilot-action='apply']",
        ".job-detail__apply",
      ],
      confidence: FIXTURE_ONLY,
      note: "SAFETY-CRITICAL. The apply action will never click a node that one of these candidates did not match; a miss yields BlockReason 'selector-missing' rather than a blind click.",
    },
    alreadyAppliedMarker: {
      candidates: ["[data-jobpilot-state='applied']", ".job-detail__applied-badge"],
      confidence: FIXTURE_ONLY,
      note: "Evidence of a prior application. Treated as a safe, non-blocking outcome.",
    },
    applySuccessMarker: {
      candidates: ["[data-jobpilot-state='applied']", ".toast--success"],
      confidence: UNVERIFIED,
      note: "Post-click confirmation evidence. If it does not appear the action returns 'needs-confirmation' — it never assumes success from the click alone.",
    },
    applyDialog: {
      candidates: ["[role='dialog']", ".dialog__panel"],
      confidence: UNVERIFIED,
      note: "BOSS often shows a greeting/consent dialog before the application is really sent. Its presence downgrades the outcome.",
    },
    applyDialogSubmit: {
      candidates: [
        "[role='dialog'] [data-jobpilot-action='apply-confirm']",
        "[role='dialog'] button[type='submit']",
      ],
      confidence: UNVERIFIED,
      note: "Used only to *describe* the dialog in evidence. The adapter does not auto-submit dialogs, because doing so blindly is exactly the class of guess this adapter refuses to make.",
    },
  },
  guards: {
    captcha: {
      candidates: [
        "[data-jobpilot-guard='captcha']",
        "#captcha",
        ".captcha-container",
        "[class*='geetest']",
        "[id*='captcha']",
      ],
      confidence: FIXTURE_ONLY,
      note: "Last two candidates are heuristic substrings. Over-matching here is acceptable: a false positive pauses, a false negative proceeds into a challenge.",
    },
    riskControl: {
      candidates: [
        "[data-jobpilot-guard='risk-control']",
        "[class*='risk']",
        "[class*='verify-wrap']",
      ],
      confidence: UNVERIFIED,
      note: "Heuristic. Real risk-control interstitials are not documented; `[class*='risk']` may over-match decorative class names.",
    },
    loginRequired: {
      candidates: [
        "[data-jobpilot-guard='login-required']",
        "[data-jobpilot-guard='login-expired']",
        ".login-register",
        ".sign-wrap",
        "[class*='login-dialog']",
      ],
      confidence: FIXTURE_ONLY,
      note: "Fixture uses the data-jobpilot-guard hooks. Real BOSS login surfaces are guessed and may be absent or renamed.",
    },
    loginForm: {
      candidates: [
        "form[data-jobpilot-guard='login-form']",
        "form.login-form",
        ".login-form__body",
      ],
      confidence: FIXTURE_ONLY,
      note: "Used only by the text fallback in detectLoginRequired; never clicked. JobPilot does not log in on the user's behalf.",
    },
    emptyResult: {
      candidates: ["[data-jobpilot-guard='empty']", ".job-list-empty", "[class*='empty-wrapper']"],
      confidence: FIXTURE_ONLY,
      note: "Checked AFTER the list parser has already parsed zero cards, so it can never mask a non-empty list.",
    },
    jobDetailRoot: {
      candidates: [
        "[data-jobpilot-detail]",
        "[itemtype='https://schema.org/JobPosting']",
        "main.job-detail",
      ],
      confidence: FIXTURE_ONLY,
      note: "Positive structural evidence for classifyJobDetail. Its absence keeps classification at 'unknown'.",
    },
    jobListRoot: {
      candidates: ["[data-jobpilot-list]", "ul.job-list", "[class*='job-list-wrapper']"],
      confidence: FIXTURE_ONLY,
      note: "Positive structural evidence for classifyJobList. Its absence keeps classification at 'unknown'.",
    },
  },
} as const;

/** Keys that have MULTIPLE alternative candidates (used by the exhaustive tests). */
export const MULTI_CANDIDATE_KEYS = {
  list: ["card", "link", "title", "company", "salary", "location", "tags"] as const,
  detail: [
    "root",
    "title",
    "salary",
    "location",
    "companyName",
    "tags",
    "description",
    "recruiterName",
    "recruiterTitle",
    "applyButton",
    "alreadyAppliedMarker",
    "applySuccessMarker",
    "applyDialog",
  ] as const,
  guards: [
    "captcha",
    "riskControl",
    "loginRequired",
    "loginForm",
    "emptyResult",
    "jobDetailRoot",
    "jobListRoot",
  ] as const,
} as const;

/** Reports whether a target resolves only through guesses. */
export const isHeuristic = (entry: SelectorEntry): boolean => entry.confidence === "unverified";

/** All selectors as a flat list, for diagnostics tables and documentation. */
export const allSelectorEntries = (): readonly {
  readonly group: string;
  readonly key: string;
  readonly entry: SelectorEntry;
}[] => {
  const output: { group: string; key: string; entry: SelectorEntry }[] = [];
  for (const [group, groupEntries] of Object.entries(SELECTORS)) {
    for (const [key, entry] of Object.entries(groupEntries)) {
      output.push({ group, key, entry });
    }
  }
  return output;
};

/**
 * Tries each candidate with `matches` and returns the first node that satisfies
 * it, annotated with the strategy that matched.
 *
 * Returns `null` when nothing matches. It never throws (a malformed selector is
 * skipped, then reported in diagnostics) and never guesses: callers must treat
 * `null` as a hard failure and fail closed.
 */
export const queryFirstBy = (
  root: ParentNode,
  entry: SelectorEntry,
  matches: (candidate: string, root: ParentNode) => Element | null,
): LocatedElement | null => {
  for (const candidate of entry.candidates) {
    let element: Element | null = null;
    try {
      element = matches(candidate, root);
    } catch {
      // An unsupported or malformed selector must not abort detection.
      continue;
    }
    if (element !== null) {
      return {
        element,
        matchedBy: candidate,
        heuristic: entry.confidence === "unverified",
      };
    }
  }
  return null;
};

/**
 * Resolves the first candidate of an entry that matches, reporting which one
 * won. Returns `null` when none match.
 */
export const queryFirst = (root: ParentNode, entry: SelectorEntry): LocatedElement | null =>
  queryFirstBy(root, entry, (candidate, scope) => scope.querySelector(candidate));

/**
 * Like `queryFirst`, but for targets that legitimately resolve to many nodes
 * (requirement bullets, skill chips). Returns an empty array — never `null`
 * and never a throw — when nothing matches.
 */
export const queryAllFirst = (root: ParentNode, entry: SelectorEntry): readonly Element[] => {
  for (const candidate of entry.candidates) {
    let elements: readonly Element[] = [];
    try {
      elements = Array.from(root.querySelectorAll(candidate));
    } catch {
      continue;
    }
    if (elements.length > 0) return elements;
  }
  return [];
};
