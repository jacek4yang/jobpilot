/**
 * BOSS Zhipin selector registry — the single source of truth for every DOM
 * query the BOSS adapter performs.
 *
 * ============================ HONESTY NOTICE ============================
 * This file was written blind, then partially grounded: on 2026-09-21 a
 * read-only recon harness captured the REAL live-site DOM (logged-in session)
 * under `test-results/live/2026-09-21/recon/result/` (list page, detail
 * drawer, chat list, open conversation). Entries that cite that capture are
 * marked accordingly; everything else remains a guess.
 *
 * Every entry carries an explicit `confidence` field, in a strict ladder:
 *   - "fixture-only"   — asserted by the synthetic fixtures under
 *     `tests/fixtures/boss/`, which were authored to match this file. Matching
 *     a fixture proves the parser plumbing works; it says NOTHING about the
 *     real site. Weakest rung.
 *   - "unverified"     — a heuristic guess about real BOSS markup. It may match
 *     nothing, or match the wrong element, on the live site.
 *   - "recon-verified" — observed in the 2026-09-21 read-only capture of the
 *     live site. The element exists and looks as described in that capture;
 *     it may still drift in future site updates, and capture coverage is
 *     partial (see each entry's note for what was and was not seen).
 *   - "verified"       — NOT USED. Reserved for selectors proven by a
 *     live-shipped diagnostic bundle. Do not invent this value.
 *
 * Consequently `BOSS_METADATA.automationVerified` is `false` and must remain
 * so: recon evidence is not shipped-diagnostic evidence. Promoting any entry
 * beyond "recon-verified" requires the bundle evidence described above.
 *
 * Candidates are ordered real-first: recon-verified live-site anchors lead,
 * then fixture/semantic hooks, then structural guesses. `queryFirst` walks
 * them in order and reports which one won, so diagnostics can tell a captured
 * anchor from a guess.
 * =======================================================================
 */

import type { LocatedElement } from "../../ports/job-platform";

/**
 * Confidence in a selector, in the ladder documented in the header:
 * fixture-only < unverified < recon-verified < verified.
 *
 * `"fixture-only"` is deliberately NOT called "verified": it only asserts
 * agreement with our own synthetic fixture, never with the real site.
 * `"recon-verified"` cites the 2026-09-21 read-only live-site capture.
 * `"verified"` is intentionally absent: it requires shipped-diagnostic
 * evidence and must not be claimed until that exists.
 */
export type SelectorConfidence = "fixture-only" | "unverified" | "recon-verified";

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
const RECON_VERIFIED = "recon-verified" as const;

/**
 * Card candidates, real-first.
 *
 * The 2026-09-21 list-page capture (002-list.json) shows cards as
 * `<div class="job-card-wrap">` (carrying `.active` when selected) wrapping an
 * inner `<li class="job-card-box">`; 150 `.job-card-wrap` nodes were present
 * on one scrolled list. The remaining candidates are the fixture hook and
 * structural fallbacks, kept so fixture-shaped and older markup still parse.
 */
const CARD_CANDIDATES: readonly string[] = [
  // Observed on the live site (2026-09-21 capture).
  ".job-card-wrap",
  // Semantic author hooks the fixture sets explicitly.
  "[data-jobpilot-card]",
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
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: 150 `.job-card-wrap` cards on one scrolled list, each wrapping an inner `li.job-card-box` (002-list.json). The data-jobpilot-card and class candidates are fixture/fallback shapes kept for older markup.",
    },
    link: {
      candidates: [
        "a.job-name[href]",
        "a[href*='/job_detail/']",
        "[data-jobpilot-link][href]",
        "a.job-card__link[href]",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: the card title is an `a.job-name` whose href is `/job_detail/{jobId}.html` (152 matches, 002-list.json). The href-substring and fixture candidates are fallbacks.",
    },
    title: {
      candidates: [
        ".job-name",
        "[itemprop='title']",
        "[data-jobpilot-field='title']",
        "h3.job-card__title",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: the card title anchor carries class `job-name` (151 matches, 002-list.json). The itemprop and class candidates are fixture/fallback shapes.",
    },
    company: {
      candidates: [
        ".job-card-footer .boss-name",
        ".boss-info .boss-name",
        "[itemprop='hiringOrganization'] [itemprop='name']",
        "[data-jobpilot-field='company']",
        ".job-card__company",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: on the current list UI the `span.boss-name` inside `.job-card-footer a.boss-info` carries the COMPANY name (e.g. 意聪科技, 150 matches), NOT a recruiter name — do not read it as a person. 002-list.json.",
    },
    salary: {
      candidates: [
        ".job-salary",
        "[itemprop='baseSalary']",
        "[data-jobpilot-field='salary']",
        ".job-card__salary",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: `span.job-salary` present on all 151 cards (002-list.json). PUA font obfuscation observed in the capture: the text is PUA codepoints, not digits, so parseSalary fails soft and salary.parsed stays false on the live list.",
    },
    location: {
      candidates: [
        ".company-location",
        "[itemprop='jobLocation']",
        "[data-jobpilot-field='location']",
        ".job-card__location",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: `span.company-location` in the card footer carries `{city}·{district}·{area}` (e.g. 西安·雁塔区·鱼化寨, 002-list.json). Feeds parseLocation; an empty match yields an unknown city rather than a wrong one.",
    },
    jobIdAttribute: {
      candidates: ["data-job-id", "data-jobid", "data-jid"],
      confidence: FIXTURE_ONLY,
      note: "Attribute names, not selectors. The 2026-09-21 capture found NO id attribute on any of the 151 live cards — the id lives only in the detail-link href path — so readPlatformJobId reads the href first and consults these attributes last, as fallbacks for fixture-shaped or older markup.",
    },
    tags: {
      candidates: [
        ".tag-list li",
        "[data-jobpilot-field='tags'] .job-card__tag",
        ".job-card__tags .job-card__tag",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: the card carries `ul.tag-list` with bare `<li>` chips such as 1-3年 / 本科 (303 `<li>` across 151 cards, 002-list.json). Tag text is still advisory for downstream rules.",
    },
  },
  detail: {
    root: {
      candidates: [
        ".job-detail-container",
        "[data-jobpilot-detail]",
        "[itemtype='https://schema.org/JobPosting']",
        "main.job-detail",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21 for the DETAIL DRAWER: clicking a list card opens `div.job-detail-container > div.job-detail-box` inline, URL unchanged (004-detail.json, 006-detail2.json). CAVEAT: the full standalone detail page (the `.job-sec-info` family) is NOT yet evidenced — it probed zero in the drawer capture — so the non-drawer candidates remain unverified fallbacks within this entry. Presence of this root is one of the two positive requirements for classifyJobDetail.",
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
      // NOTE: these candidates must select the individual meta ITEMS, not the
      // container. `queryAllFirst` takes the first candidate that matches
      // anything, so a container selector here would silently collapse every
      // item into one blob of text.
      candidates: [
        "[data-jobpilot-field='company-meta'] > li",
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
      candidates: [
        ".job-boss-info .name",
        "[data-jobpilot-field='recruiter']",
        ".job-detail__recruiter-name",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: the drawer recruiter card is `div.job-boss-info` with `h2.name` (e.g. 曹蕾蕾, 004-detail.json). CAUTION: that h2 nests a `span.boss-online-tag` (在线/activity labels), so plain textContent appends the status text — the detail parser reads the name with that child excluded.",
    },
    recruiterTitle: {
      candidates: [
        ".job-boss-info .boss-info-attr",
        "[data-jobpilot-field='recruiter-title']",
        ".job-detail__recruiter-title",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: `div.job-boss-info .boss-info-attr` carries `{company} · {role}` (capture evidence: 芝麻数据 · 招聘者, 004-detail.json). Used only for display and the 猎头 substring check.",
    },
    applyButton: {
      candidates: [
        ".op-btn-chat",
        "button[data-jobpilot-action='apply']",
        "[role='button'][data-jobpilot-action='apply']",
        ".job-detail__apply",
      ],
      confidence: RECON_VERIFIED,
      note: "SAFETY-CRITICAL. The apply action will never click a node that one of these candidates did not match; a miss yields BlockReason 'selector-missing' rather than a blind click. Recon-verified 2026-09-21: on the live drawer the control is `<a class=\"op-btn op-btn-chat\">立即沟通</a>` inside `div.job-detail-op`, and its `ka` attribute embeds the jobId (`cpc_job_list_chat_{jobId}`); the sibling `a.op-btn-like` is 收藏 and must never be clicked. Consumers must still verify the ENTIRE label is exactly 立即沟通 before any click — the apply action enforces this in the same style as the send-button 发送 filter.",
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
        "[class*='login-dialog']",
      ],
      confidence: FIXTURE_ONLY,
      note: 'Fixture uses the data-jobpilot-guard hooks. `.sign-wrap` was REMOVED as a candidate: the 2026-09-21 capture shows `.sign-wrap` login markup present in the DOM with `style="display: none"` on LOGGED-IN pages — a proven false positive as a login-required structural selector. Real logged-out BOSS surfaces are still only guessed (the capture saw none); the page-kind login text fallback remains the live backstop.',
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
        ".job-detail-container",
        "[data-jobpilot-detail]",
        "[itemtype='https://schema.org/JobPosting']",
        "main.job-detail",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21 for the DETAIL DRAWER (`div.job-detail-container`, 004-detail.json) with the same caveat as detail.root: the full standalone detail page (`.job-sec-info` family) is NOT yet evidenced and the remaining candidates are unverified fallbacks. Positive structural evidence for classifyJobDetail; its absence keeps classification at 'unknown'.",
    },
    jobListRoot: {
      candidates: [
        ".job-list-container",
        "[data-jobpilot-list]",
        "ul.job-list",
        "[class*='job-list-wrapper']",
      ],
      confidence: RECON_VERIFIED,
      note: "Recon-verified 2026-09-21: `div.job-list-container` wraps `ul.rec-job-list` on the live search page (002-list.json). The remaining candidates are fixture/fallback shapes. Positive structural evidence for classifyJobList; its absence keeps classification at 'unknown'.",
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
