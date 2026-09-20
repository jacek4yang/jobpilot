import {
  alreadyProcessedRule,
  companyBlacklistRule,
  educationRule,
  experienceRule,
  headhunterRule,
  jobText,
  keywordRule,
  locationRule,
  outsourcingRule,
  salaryRule,
} from "./hard-filters";
import type { JobDetail } from "./job/job";
import { normalizeCity } from "./job/location";
import {
  type KeywordWeight,
  type Rule,
  type RuleEngineConfig,
  type RuleResult,
  softScore,
} from "./rule";

/**
 * Finds configured keywords present in a text surface.
 *
 * Matching is case-insensitive on BOTH sides: configured keywords are written
 * by hand in the UI and may be typed in any case, while job text mixes cases
 * freely ("TypeScript" vs "typescript").
 */
const hitsFor = (haystack: string, weights: readonly KeywordWeight[]): KeywordWeight[] => {
  const normalized = haystack.toLowerCase();
  return weights.filter((entry) => normalized.includes(entry.keyword.toLowerCase()));
};

const sumWeights = (hits: readonly KeywordWeight[]): number =>
  hits.reduce((total, hit) => total + hit.weight, 0);

const describe = (label: string, hits: readonly KeywordWeight[], total: number): string =>
  hits.length === 0
    ? `${label}: no match`
    : `${label}: ${hits.map((hit) => hit.keyword).join(", ")} (+${total})`;

/** Scores hits of weighted keywords against the job title. */
export const createTitleKeywordRule = (weights: readonly KeywordWeight[]): Rule => ({
  id: "soft.title-keywords",
  kind: "soft",
  evaluate(job: JobDetail): RuleResult {
    const hits = hitsFor(job.title, weights);
    const total = sumWeights(hits);
    return softScore(this.id, total, describe("title keywords", hits, total));
  },
});

/** Scores hits of weighted keywords against description + requirements + skills. */
export const createDescriptionKeywordRule = (weights: readonly KeywordWeight[]): Rule => ({
  id: "soft.description-keywords",
  kind: "soft",
  evaluate(job: JobDetail): RuleResult {
    const hits = hitsFor(jobText(job), weights);
    const total = sumWeights(hits);
    return softScore(this.id, total, describe("description keywords", hits, total));
  },
});

/** Scores exact matches against the parser-extracted skill list. */
export const createSkillRule = (weights: readonly KeywordWeight[]): Rule => ({
  id: "soft.skills",
  kind: "soft",
  evaluate(job: JobDetail): RuleResult {
    const skills = job.skills.map((skill) => skill.toLowerCase());
    const hits = weights.filter((entry) => skills.includes(entry.keyword.toLowerCase()));
    const total = sumWeights(hits);
    return softScore(this.id, total, describe("preferred skills", hits, total));
  },
});

/** Scores the job city against the user's preferred-city weights. */
export const createCityPreferenceRule = (weights: readonly KeywordWeight[]): Rule => ({
  id: "soft.city-preference",
  kind: "soft",
  evaluate(job: JobDetail): RuleResult {
    if (job.location.city.length === 0) {
      return softScore(this.id, 0, "preferred cities: city unknown");
    }
    const normalized = normalizeCity(job.location.city);
    const hits = weights.filter((entry) => normalizeCity(entry.keyword) === normalized);
    const total = sumWeights(hits);
    return softScore(this.id, total, describe("preferred cities", hits, total));
  },
});

/**
 * Rewards salary above the user's own configured minimum.
 *
 * Bands are relative to `hard.minSalaryK` so the signal tracks the user's
 * baseline rather than a hardcoded market assumption. When no minimum is
 * configured the rule contributes nothing: inventing a baseline would add a
 * constant offset to every score and make the absolute score meaningless.
 */
export const createSalaryQualityRule = (baselineK: number): Rule => ({
  id: "soft.salary-quality",
  kind: "soft",
  evaluate(job: JobDetail): RuleResult {
    if (baselineK <= 0) {
      return softScore(this.id, 0, "salary quality: no minimum salary configured");
    }
    if (!job.salary.parsed || job.salary.min === undefined) {
      return softScore(this.id, 0, "salary unknown");
    }
    const ratio = job.salary.min / baselineK;
    const rounded = ratio.toFixed(2);
    if (ratio >= 1.6) return softScore(this.id, 12, `salary is well above baseline (${rounded}x)`);
    if (ratio >= 1.2) return softScore(this.id, 8, `salary is above baseline (${rounded}x)`);
    if (ratio >= 1.0) return softScore(this.id, 4, `salary meets baseline (${rounded}x)`);
    return softScore(this.id, 0, `salary near or below baseline (${rounded}x)`);
  },
});

/**
 * Builds the ordering of hard filters. Order is significant: cheap,
 * high-signal rejections (already processed, location) run before
 * text-heavy ones so diagnostics stay readable.
 */
export const createHardRules = (): readonly Rule[] => [
  alreadyProcessedRule,
  locationRule,
  salaryRule,
  educationRule,
  experienceRule,
  keywordRule,
  companyBlacklistRule,
  outsourcingRule,
  headhunterRule,
];

/** Builds the platform-independent soft scoring rule set from user weights. */
export const createScoringRules = (config: RuleEngineConfig): readonly Rule[] => [
  createTitleKeywordRule(config.scoring.titleKeywords),
  createDescriptionKeywordRule(config.scoring.descriptionKeywords),
  createSkillRule(config.scoring.preferredSkills),
  createCityPreferenceRule(config.scoring.preferredCities),
  createSalaryQualityRule(config.hard.minSalaryK),
];
