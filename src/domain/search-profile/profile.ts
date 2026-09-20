/**
 * Search profile.
 *
 * A profile is a named, reusable search intent. JobPilot supports several at
 * once ("Rust Backend", "Security Research", "Graduate Jobs") because a real job
 * search is rarely one query.
 *
 * Field names and value vocabularies follow the dimensions BOSS actually
 * exposes, which the reference scraper confirms via its own filters
 * (scale / salary / experience / degree / funding / industry).
 */

/** Recruiter activity recency, normalised from BOSS's own labels. */
export type ActivityPreference =
  | "any"
  | "online"
  | "today"
  | "within_3_days"
  | "within_7_days"
  | "within_30_days";

export const ACTIVITY_PREFERENCES: readonly ActivityPreference[] = [
  "any",
  "online",
  "today",
  "within_3_days",
  "within_7_days",
  "within_30_days",
];

export const ACTIVITY_LABELS: Readonly<Record<ActivityPreference, string>> = {
  any: "Any activity",
  online: "Online now",
  today: "Active today",
  within_3_days: "Active within 3 days",
  within_7_days: "Active within 7 days",
  within_30_days: "Active within 30 days",
};

/**
 * Education levels, using BOSS's own vocabulary.
 *
 * The exact strings come from the reference scraper's `is_degree_tag`, which
 * enumerates the values BOSS emits in job tags.
 */
export type DegreeLevel =
  | "不限"
  | "初中及以下"
  | "中专/中技"
  | "高中"
  | "大专"
  | "本科"
  | "硕士"
  | "博士";

export const DEGREE_LEVELS: readonly DegreeLevel[] = [
  "不限",
  "初中及以下",
  "中专/中技",
  "高中",
  "大专",
  "本科",
  "硕士",
  "博士",
];

/** Experience bands, expressed as the bands BOSS's search filter offers. */
export type ExperienceBand =
  | "经验不限"
  | "应届生"
  | "在校生"
  | "1年以内"
  | "1-3年"
  | "3-5年"
  | "5-10年"
  | "10年以上";

export const EXPERIENCE_BANDS: readonly ExperienceBand[] = [
  "经验不限",
  "应届生",
  "在校生",
  "1年以内",
  "1-3年",
  "3-5年",
  "5-10年",
  "10年以上",
];

/** Company size bands, matching BOSS's filter options. */
export type CompanyScale =
  | "0-20人"
  | "20-99人"
  | "100-499人"
  | "500-999人"
  | "1000-9999人"
  | "10000人以上";

export const COMPANY_SCALES: readonly CompanyScale[] = [
  "0-20人",
  "20-99人",
  "100-499人",
  "500-999人",
  "1000-9999人",
  "10000人以上",
];

export interface SalaryPreference {
  /** Minimum acceptable monthly salary in K. 0 means "no minimum". */
  readonly minK: number;
  /** Maximum, 0 meaning "no maximum". */
  readonly maxK: number;
}

export interface SearchProfile {
  readonly id: string;
  readonly name: string;

  /** Search terms sent to BOSS. */
  readonly keywords: readonly string[];
  /** City names. Must resolve via the BOSS city table; unknown names fail. */
  readonly cities: readonly string[];

  readonly salary?: SalaryPreference;
  readonly experience?: readonly ExperienceBand[];
  readonly degree?: readonly DegreeLevel[];
  readonly companyScales?: readonly CompanyScale[];

  readonly recruiterActivity?: ActivityPreference;
  /** When true, a job whose activity cannot be determined is skipped. */
  readonly skipUnknownActivity?: boolean;

  /** At least one must appear for the job to survive filtering. */
  readonly includeKeywords: readonly string[];
  /** Any appearance rejects the job. */
  readonly excludeKeywords: readonly string[];

  readonly enabled: boolean;
}

export interface CreateProfileInput {
  readonly id: string;
  readonly name: string;
  readonly keywords?: readonly string[];
  readonly cities?: readonly string[];
  readonly salary?: SalaryPreference;
  readonly experience?: readonly ExperienceBand[];
  readonly degree?: readonly DegreeLevel[];
  readonly companyScales?: readonly CompanyScale[];
  readonly recruiterActivity?: ActivityPreference;
  readonly skipUnknownActivity?: boolean;
  readonly includeKeywords?: readonly string[];
  readonly excludeKeywords?: readonly string[];
  readonly enabled?: boolean;
}

/**
 * Creates a profile.
 *
 * Defaults are deliberately *empty* rather than opinionated. The reference
 * implementation ships QA/testing keywords and sales exclusions as defaults;
 * shipping those as JobPilot's universal defaults would silently filter every
 * user's results to one person's job search.
 */
export const createProfile = (input: CreateProfileInput): SearchProfile => ({
  id: input.id,
  name: input.name.trim(),
  keywords: input.keywords ?? [],
  cities: input.cities ?? [],
  includeKeywords: input.includeKeywords ?? [],
  excludeKeywords: input.excludeKeywords ?? [],
  enabled: input.enabled ?? true,
  ...(input.salary === undefined ? {} : { salary: input.salary }),
  ...(input.experience === undefined ? {} : { experience: input.experience }),
  ...(input.degree === undefined ? {} : { degree: input.degree }),
  ...(input.companyScales === undefined ? {} : { companyScales: input.companyScales }),
  ...(input.recruiterActivity === undefined ? {} : { recruiterActivity: input.recruiterActivity }),
  ...(input.skipUnknownActivity === undefined
    ? {}
    : { skipUnknownActivity: input.skipUnknownActivity }),
});

export const DUPLICATE_SUFFIX = " copy";

/**
 * Duplicates a profile under a fresh id and a non-colliding name.
 * `existingNames` is passed in so this stays pure.
 */
export const duplicateProfile = (
  profile: SearchProfile,
  newId: string,
  existingNames: readonly string[],
): SearchProfile => {
  let candidate = `${profile.name}${DUPLICATE_SUFFIX}`;
  let counter = 2;
  while (existingNames.includes(candidate)) {
    candidate = `${profile.name}${DUPLICATE_SUFFIX} ${counter}`;
    counter += 1;
  }
  return { ...profile, id: newId, name: candidate };
};
