/**
 * Mapping between persisted config and the domain search profile.
 *
 * The config layer stores `StoredSearchProfile` (plain records) so it does not
 * depend on the domain; the domain owns `SearchProfile` (typed unions). This
 * module is the single boundary between them.
 *
 * Mapping is deliberately lossy in one direction only: going *in* to the
 * domain, values that are not valid members of a union are DROPPED rather than
 * coerced. A typo in a hand-edited config therefore narrows a filter instead of
 * silently widening it, which is the safer direction for a job search.
 */
import type { StoredSearchProfile } from "../config/schema";
import type { KeywordWeight } from "../domain/rule";
import {
  type ActivityPreference,
  COMPANY_SCALES,
  type CompanyScale,
  DEGREE_LEVELS,
  type DegreeLevel,
  DUPLICATE_SUFFIX,
  EXPERIENCE_BANDS,
  type ExperienceBand,
  type SearchProfile,
} from "../domain/search-profile/profile";

const ACTIVITY_SET: ReadonlySet<string> = new Set([
  "any",
  "online",
  "today",
  "within_3_days",
  "within_7_days",
  "within_30_days",
]);

/** Keeps only values that are valid members of `allowed`. */
const keepKnown = <T extends string>(
  values: readonly string[] | undefined,
  allowed: readonly T[],
): readonly T[] => {
  if (values === undefined) return [];
  const set: ReadonlySet<string> = new Set(allowed);
  return values.filter((value): value is T => set.has(value));
};

/** Converts a persisted profile into a domain profile. */
export const toDomainProfile = (stored: StoredSearchProfile): SearchProfile => {
  const degree = keepKnown<DegreeLevel>(stored.degree, DEGREE_LEVELS);
  const experience = keepKnown<ExperienceBand>(stored.experience, EXPERIENCE_BANDS);
  const companyScales = keepKnown<CompanyScale>(stored.companyScales, COMPANY_SCALES);
  const activity =
    stored.recruiterActivity !== undefined && ACTIVITY_SET.has(stored.recruiterActivity)
      ? (stored.recruiterActivity as ActivityPreference)
      : undefined;

  const salary =
    stored.salaryMinK !== undefined || stored.salaryMaxK !== undefined
      ? { minK: stored.salaryMinK ?? 0, maxK: stored.salaryMaxK ?? 0 }
      : undefined;

  return {
    id: stored.id,
    name: stored.name,
    keywords: stored.keywords,
    cities: stored.cities,
    includeKeywords: stored.includeKeywords,
    excludeKeywords: stored.excludeKeywords,
    enabled: stored.enabled,
    ...(salary === undefined ? {} : { salary }),
    ...(degree.length === 0 ? {} : { degree }),
    ...(experience.length === 0 ? {} : { experience }),
    ...(companyScales.length === 0 ? {} : { companyScales }),
    ...(activity === undefined ? {} : { recruiterActivity: activity }),
    ...(stored.skipUnknownActivity === undefined
      ? {}
      : { skipUnknownActivity: stored.skipUnknownActivity }),
  };
};

/** Converts a domain profile back into its persisted form. */
export const toStoredProfile = (profile: SearchProfile): StoredSearchProfile => ({
  id: profile.id,
  name: profile.name,
  keywords: profile.keywords,
  cities: profile.cities,
  includeKeywords: profile.includeKeywords,
  excludeKeywords: profile.excludeKeywords,
  enabled: profile.enabled,
  ...(profile.salary === undefined
    ? {}
    : { salaryMinK: profile.salary.minK, salaryMaxK: profile.salary.maxK }),
  ...(profile.degree === undefined ? {} : { degree: profile.degree }),
  ...(profile.experience === undefined ? {} : { experience: profile.experience }),
  ...(profile.companyScales === undefined ? {} : { companyScales: profile.companyScales }),
  ...(profile.recruiterActivity === undefined
    ? {}
    : { recruiterActivity: profile.recruiterActivity }),
  ...(profile.skipUnknownActivity === undefined
    ? {}
    : { skipUnknownActivity: profile.skipUnknownActivity }),
});

/**
 * Derives the rule-engine keyword weights from a profile.
 *
 * Profile keywords become title weights and include-keywords become description
 * weights, so a profile automatically influences scoring without the user
 * having to maintain two lists.
 */
export const profileToWeights = (
  profile: SearchProfile,
): {
  readonly title: readonly KeywordWeight[];
  readonly description: readonly KeywordWeight[];
} => ({
  title: profile.keywords.map((keyword) => ({ keyword, weight: 15 })),
  description: profile.includeKeywords.map((keyword) => ({ keyword, weight: 10 })),
});

export { DUPLICATE_SUFFIX };
