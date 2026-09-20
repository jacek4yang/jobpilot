/**
 * Recruiter ("BOSS") activity.
 *
 * Activity is a strong signal of whether contacting a recruiter is worthwhile,
 * but it is also easy to read incorrectly: the label appears inside rich text
 * that also contains job descriptions, and contradictory labels can coexist.
 *
 * Two rules govern this module:
 *  1. Parsing is exact. A label is recognised only if the whole trimmed string
 *     matches a known pattern; substrings inside prose never count.
 *  2. When several labels are present, the *least* active one wins. Optimism
 *     here would mean messaging a recruiter who has not logged in for months.
 */
import type { ActivityPreference } from "../search-profile/profile";

export type ActivityRecency =
  | "online"
  | "today"
  | "within_3_days"
  | "within_7_days"
  | "within_30_days"
  | "inactive"
  | "unknown";

export interface RecruiterActivity {
  /** The exact label that was matched, preserved for the UI. */
  readonly label: string;
  readonly recency: ActivityRecency;
  /** Days since last activity; 0 for online/today, Infinity for inactive. */
  readonly days: number;
  /** True only for an explicit "online now" label. */
  readonly online: boolean;
}

const DAY = 1;

/** Ordered patterns. Order matters only for readability; each is exact. */
const LABEL_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly build: (label: string, match: RegExpMatchArray) => RecruiterActivity;
}[] = [
  {
    pattern: /^(?:在线|当前在线|正在在线)$/,
    build: (label) => ({ label, recency: "online", days: 0, online: true }),
  },
  {
    pattern: /^(?:刚刚活跃|刚刚在线|今日活跃|今天活跃|今日在线|今天在线)$/,
    build: (label) => ({ label, recency: "today", days: 0, online: false }),
  },
  {
    pattern: /^(?:昨日|昨天)(?:活跃|在线)$/,
    build: (label) => ({ label, recency: "within_3_days", days: DAY, online: false }),
  },
  {
    pattern: /^\d+分钟前(?:活跃|在线)?$/,
    build: (label) => ({ label, recency: "today", days: 0, online: false }),
  },
  {
    pattern: /^(\d+)小时前(?:活跃|在线)?$/,
    build: (label, match) => {
      const hours = Number(match[1] ?? "0");
      const days = Math.ceil(hours / 24);
      return { label, recency: days <= 1 ? "today" : "within_3_days", days, online: false };
    },
  },
  {
    // `3天前活跃`, `近7天活跃`, `7日内在线`. The `内/前/以` infix is optional
    // because BOSS renders some of these without it.
    pattern: /^(?:近|过去|最近)?(\d+)(?:天|日)(?:内|前|以)?(?:活跃|在线)$/,
    build: (label, match) => {
      const days = Number(match[1] ?? "0");
      return { label, recency: bandForDays(days), days, online: false };
    },
  },
  {
    pattern: /^(?:本周|近一周|一周内)(?:活跃|在线)$/,
    build: (label) => ({ label, recency: "within_7_days", days: 7, online: false }),
  },
  {
    pattern: /^(?:本月|近一个月|一个月内)(?:活跃|在线)$/,
    build: (label) => ({ label, recency: "within_30_days", days: 30, online: false }),
  },
  {
    pattern: /^(?:近期|最近|长期未|很久未|半年前|一年前)(?:活跃|在线)$/,
    build: (label) => ({ label, recency: "inactive", days: Number.POSITIVE_INFINITY, online: false }),
  },
  {
    pattern: /^(?:离线|不在线|不活跃)$/,
    build: (label) => ({ label, recency: "inactive", days: Number.POSITIVE_INFINITY, online: false }),
  },
];

const bandForDays = (days: number): ActivityRecency => {
  if (days <= 0) return "today";
  if (days <= 3) return "within_3_days";
  if (days <= 7) return "within_7_days";
  if (days <= 30) return "within_30_days";
  return "inactive";
};

/**
 * Parses one candidate label.
 *
 * Returns `undefined` for anything that is not exactly a known activity label,
 * so prose such as "我们希望你一周内到岗" cannot be mistaken for activity.
 */
export const parseActivityLabel = (raw: string | undefined | null): RecruiterActivity | undefined => {
  if (raw === undefined || raw === null) return undefined;
  // Collapse internal whitespace: BOSS renders some labels with stray spaces.
  const label = raw.replace(/\s+/g, "").trim();
  if (label.length === 0) return undefined;

  for (const entry of LABEL_PATTERNS) {
    const match = entry.pattern.exec(label);
    if (match !== null) return entry.build(label, match);
  }
  return undefined;
};

/**
 * Parses many candidate labels and picks the most conservative result.
 *
 * Contradictory labels are common while the DOM is settling. Choosing the least
 * active reading means a transient optimistic label cannot cause a message to a
 * dormant recruiter.
 */
export const pickMostConservativeActivity = (
  labels: readonly string[],
): RecruiterActivity | undefined => {
  const parsed = labels
    .map((label) => parseActivityLabel(label))
    .filter((activity): activity is RecruiterActivity => activity !== undefined);

  if (parsed.length === 0) return undefined;

  return parsed.reduce((least, candidate) => {
    if (candidate.days > least.days) return candidate;
    if (candidate.days < least.days) return least;
    // Same recency: prefer "not online" over "online".
    if (least.online && !candidate.online) return candidate;
    return least;
  });
};

/** Days allowed by each preference. `online` is handled separately. */
const PREFERENCE_LIMIT_DAYS: Readonly<Record<Exclude<ActivityPreference, "any" | "online">, number>> = {
  today: 0,
  within_3_days: 3,
  within_7_days: 7,
  within_30_days: 30,
};

export type ActivityVerdict =
  | { readonly kind: "pass"; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Applies the user's activity preference to an observed activity.
 *
 * An unreadable activity is *not* silently accepted: it returns `unknown`, and
 * the caller decides based on `skipUnknownActivity`. Making that decision
 * explicit means the UI can report which branch was taken.
 */
export const evaluateActivity = (
  activity: RecruiterActivity | undefined,
  preference: ActivityPreference,
  skipUnknown: boolean,
): ActivityVerdict => {
  if (preference === "any") {
    return { kind: "pass", reason: "activity filtering disabled" };
  }

  if (activity === undefined) {
    return skipUnknown
      ? { kind: "unknown", reason: "recruiter activity could not be read; skipped by policy" }
      : { kind: "unknown", reason: "recruiter activity could not be read; allowed by policy" };
  }

  if (preference === "online") {
    return activity.online
      ? { kind: "pass", reason: `recruiter is online (${activity.label})` }
      : { kind: "skip", reason: `recruiter is not online (${activity.label})` };
  }

  const limit = PREFERENCE_LIMIT_DAYS[preference];
  return activity.days <= limit
    ? { kind: "pass", reason: `recruiter active within ${limit} day(s) (${activity.label})` }
    : { kind: "skip", reason: `recruiter last active ${activity.label}, outside the limit` };
};

/** True when the verdict should allow the job to proceed. */
export const allowsProceeding = (verdict: ActivityVerdict, skipUnknown: boolean): boolean => {
  if (verdict.kind === "pass") return true;
  if (verdict.kind === "skip") return false;
  // `unknown` honours the configured policy.
  return !skipUnknown;
};
