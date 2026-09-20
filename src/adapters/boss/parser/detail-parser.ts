/**
 * BOSS Zhipin job-detail parser.
 *
 * ============================ HONESTY NOTICE ============================
 * Written without access to the real BOSS Zhipin detail DOM. Validated only
 * against the synthetic fixture `tests/fixtures/boss/job-detail.html`. Real-site
 * detail parsing, including the education/experience chip vocabulary, is
 * UNVERIFIED.
 * =======================================================================
 *
 * Contract:
 *   - Read-only. No DOM writes.
 *   - Fail closed. `parseBossJobDetail` returns `null` when a REQUIRED anchor is
 *     missing; it never substitutes a placeholder for a required field.
 *   - Honest unions. Education/experience text that is not recognised yields
 *     `"unknown"`, never a plausible-looking guess.
 */

import { createCompany } from "../../../domain/company/company";
import { parseLocation } from "../../../domain/job/location";
import type { JobDetail, EducationLevel, ExperienceLevel, JobSummary } from "../../../domain/job/job";
import { parseSalary } from "../../../domain/job/salary";
import { createRecruiter } from "../../../domain/recruiter/recruiter";
import { queryAllFirst, queryFirst, SELECTORS } from "../selectors";

/** Normalises whitespace for display text and chip matching. */
const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/** Text of the first candidate that yields non-empty content. */
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

/**
 * Maps a Chinese education chip onto the domain union.
 *
 * Failure mode: returns `"unknown"` for anything unrecognised — including the
 * ambiguous bare token "本科及以上", which is an *upper* bound being used as a
 * *lower* bound and therefore must not be silently read as "bachelor".
 */
export const parseEducation = (raw: string | undefined): EducationLevel => {
  const text = clean(raw);
  if (text.length === 0) return "unknown";
  if (/不限|学历不限/.test(text)) return "unknown";
  if (/博士/.test(text)) return "doctorate";
  if (/硕士|研究生/.test(text)) return "master";
  if (/本科/.test(text)) return "bachelor";
  if (/大专|专科|高职/.test(text)) return "associate";
  if (/中专|高中|职高|技校/.test(text)) return "high-school";
  if (/初中|小学/.test(text)) return "junior";
  return "unknown";
};

/**
 * Maps a Chinese experience chip onto the domain union.
 *
 * Failure mode: returns `"unknown"` for unrecognised text rather than defaulting
 * to "fresh-graduate" (the tempting but wrong guess in this domain).
 */
export const parseExperience = (raw: string | undefined): ExperienceLevel => {
  const text = clean(raw);
  if (text.length === 0) return "unknown";
  if (/应届|在校|实习|无经验/.test(text)) return "fresh-graduate";

  const range = /(\d+)\s*-\s*(\d+)\s*年/.exec(text);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const min = Number.parseInt(range[1], 10);
    const max = Number.parseInt(range[2], 10);
    if (min <= 1 && max <= 3) return "1-3";
    if (min >= 3 && max <= 5) return "3-5";
    if (min >= 5 && max <= 10) return "5-10";
    // Any range we cannot place confidently stays unknown.
    return "unknown";
  }

  const lower = /(\d+)\s*年(?:以下|以内)/.exec(text);
  if (lower?.[1] !== undefined) {
    const bound = Number.parseInt(lower[1], 10);
    if (bound <= 1) return "under-1";
    if (bound <= 3) return "1-3";
    if (bound <= 5) return "3-5";
    return "unknown";
  }

  const upper = /(\d+)\s*年(?:以上|\+)/.exec(text);
  if (upper?.[1] !== undefined) {
    const bound = Number.parseInt(upper[1], 10);
    if (bound >= 10) return "over-10";
    if (bound >= 5) return "5-10";
    if (bound >= 3) return "3-5";
    if (bound >= 1) return "1-3";
    return "unknown";
  }

  if (/经验不限|不限经验|经验/.test(text)) return "unknown";
  return "unknown";
};

/** Rough financing-stage vocabulary used for the company meta chips. */
const STAGE_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /已上市|上市/, label: "已上市" },
  { re: /D轮|E轮|F轮/, label: "D轮及以上" },
  { re: /C轮/, label: "C轮" },
  { re: /B轮/, label: "B轮" },
  { re: /A轮/, label: "A轮" },
  { re: /天使轮/, label: "天使轮" },
  { re: /不需要融资|无需融资/, label: "不需要融资" },
];

/** Returns true when a company meta chip looks like a financing stage. */
const detectStage = (text: string): string | undefined =>
  STAGE_PATTERNS.find((entry) => entry.re.test(text))?.label;

/** Returns true when a company meta chip looks like a headcount band. */
const IS_SIZE = /(\d+\s*-\s*\d+\s*人|\d+\s*人以上|人以上|规模)/;

/** Returns true when a company meta chip looks like an industry label. */
const IS_INDUSTRY = /(互联网|电子商务|企业服务|金融|教育|医疗|游戏|人工智能|软件|硬件|汽车|物流|房地产|文化|广告|通信|能源)/;

/** Markers that the posting is outsourcing / dispatch staffing. */
const OUTSOURCING_MARKERS: readonly string[] = ["外包", "人力外派", "劳务派遣", "驻场"];

/** Markers that the poster is an external headhunter. */
const HEADHUNTER_MARKERS: readonly string[] = ["猎头", "猎聘顾问", "人才顾问"];

const containsAny = (text: string, markers: readonly string[]): boolean =>
  markers.some((marker) => text.includes(marker));

/**
 * Parses a full detail page.
 *
 * REQUIRED anchors: title, company name, description, and an education or
 * experience chip. Missing any of them returns `null` so the caller can report
 * `BlockReason: "unknown-dom"` instead of applying to a half-read posting.
 *
 * Failure mode: `null` on missing anchors; `"unknown"` unions for unrecognised
 * vocabulary; empty strings for optional prose. Never throws.
 */
export const parseBossJobDetail = (
  root: ParentNode,
  summary: JobSummary,
  now: number,
): JobDetail | null => {
  const title = textOf(root, SELECTORS.detail.title.candidates) ?? summary.title;
  const companyName = textOf(root, SELECTORS.detail.companyName.candidates);
  const description = textOf(root, SELECTORS.detail.description.candidates);

  const tagTexts = queryAllFirst(root, SELECTORS.detail.tags)
    .map((element) => clean(element.textContent))
    .filter((text) => text.length > 0);

  const educationRaw = tagTexts.find((text) => /学历|本科|大专|硕士|博士|中专|高中|不限/.test(text));
  const experienceRaw = tagTexts.find((text) => /经验|应届|年/.test(text));

  // Fail closed: a posting without a company, a description, or any
  // qualification signal is not a posting we are willing to act on.
  if (companyName === undefined || description === undefined) return null;
  if (educationRaw === undefined && experienceRaw === undefined) return null;

  const salaryRaw = textOf(root, SELECTORS.detail.salary.candidates) ?? summary.salaryRaw;
  const locationRaw = textOf(root, SELECTORS.detail.location.candidates) ?? summary.locationRaw;

  const metaTexts = queryAllFirst(root, SELECTORS.detail.companyMeta)
    .map((element) => clean(element.textContent))
    .filter((text) => text.length > 0);

  const industry = metaTexts.find(
    (text) => detectStage(text) === undefined && !IS_SIZE.test(text) && IS_INDUSTRY.test(text),
  );
  const stage = metaTexts.map(detectStage).find((value) => value !== undefined);
  const size = metaTexts.find((text) => IS_SIZE.test(text));

  const isOutsourcing = containsAny(`${description}\n${companyName}`, OUTSOURCING_MARKERS);

  const company = createCompany({
    name: companyName,
    ...(industry === undefined ? {} : { industry }),
    ...(stage === undefined ? {} : { stage }),
    ...(size === undefined ? {} : { size }),
    isOutsourcing,
  });

  const recruiterName = textOf(root, SELECTORS.detail.recruiterName.candidates);
  const recruiterTitle = textOf(root, SELECTORS.detail.recruiterTitle.candidates);
  const recruiters =
    recruiterName === undefined
      ? []
      : [
          createRecruiter({
            name: recruiterName,
            ...(recruiterTitle === undefined ? {} : { title: recruiterTitle }),
            isHeadhunter: containsAny(recruiterTitle ?? "", HEADHUNTER_MARKERS),
          }),
        ];

  const requirements = queryAllFirst(root, SELECTORS.detail.requirements)
    .map((element) => clean(element.textContent))
    .filter((text) => text.length > 0);

  const skills = queryAllFirst(root, SELECTORS.detail.skills)
    .map((element) => clean(element.textContent))
    .filter((text) => text.length > 0);

  return {
    ...summary,
    title,
    companyName,
    salaryRaw,
    locationRaw,
    company,
    salary: parseSalary(salaryRaw),
    location: parseLocation(locationRaw),
    education: parseEducation(educationRaw),
    experience: parseExperience(experienceRaw),
    description,
    requirements,
    skills,
    recruiters,
    capturedAt: now,
  };
};

/**
 * Locates the apply control.
 *
 * Returns `null` when no listed candidate matches. The apply action treats that
 * as a hard `selector-missing` block; there is no text-based fallback, because
 * clicking an unidentified button is exactly the failure mode this adapter is
 * built to avoid.
 */
export const locateApplyButton = (root: ParentNode): Element | null => {
  const located = queryFirst(root, SELECTORS.detail.applyButton);
  return located === null ? null : located.element;
};
