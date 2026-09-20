import type { JobDetail } from "./job/job";

export type RuleKind = "hard" | "soft";

/** A single explainable contribution to a decision. */
export interface RuleReason {
  readonly ruleId: string;
  readonly kind: RuleKind;
  /** Positive = pushes toward accept, negative = pushes toward reject. */
  readonly delta: number;
  readonly message: string;
}

export interface RuleResult {
  readonly ruleId: string;
  readonly kind: RuleKind;
  /**
   * Hard rules: false means the job is rejected outright.
   * Soft rules: always true; they only contribute score.
   */
  readonly passed: boolean;
  readonly score: number;
  readonly reason: RuleReason;
}

export interface RuleContext {
  readonly now: number;
  /** Job ids already present in application history. */
  readonly processedJobIds: ReadonlySet<string>;
  readonly config: RuleEngineConfig;
}

export interface KeywordWeight {
  readonly keyword: string;
  readonly weight: number;
}

export interface HardFilterConfig {
  readonly cities: readonly string[];
  readonly minSalaryK: number;
  readonly maxSalaryK: number;
  readonly education: readonly string[];
  readonly experience: readonly string[];
  /** Job must contain at least one of these when non-empty. */
  readonly includeKeywords: readonly string[];
  /** Job must contain none of these. */
  readonly excludeKeywords: readonly string[];
  readonly companyBlacklist: readonly string[];
  readonly excludeOutsourcing: boolean;
  readonly excludeHeadhunter: boolean;
}

export interface ScoringConfig {
  readonly baseScore: number;
  /** Score at or above which a job is auto-approved. */
  readonly acceptThreshold: number;
  readonly titleKeywords: readonly KeywordWeight[];
  readonly descriptionKeywords: readonly KeywordWeight[];
  readonly preferredSkills: readonly KeywordWeight[];
  readonly preferredCities: readonly KeywordWeight[];
}

export interface RuleEngineConfig {
  readonly hard: HardFilterConfig;
  readonly scoring: ScoringConfig;
}

export interface Rule {
  readonly id: string;
  readonly kind: RuleKind;
  evaluate(job: JobDetail, context: RuleContext): RuleResult;
}

export interface Evaluation {
  readonly jobId: string;
  readonly accepted: boolean;
  readonly score: number;
  readonly reasons: readonly RuleReason[];
  /** Hard rules that failed, in evaluation order. Empty when accepted. */
  readonly rejections: readonly RuleReason[];
}

export const rejection = (ruleId: string, message: string, delta = 0): RuleResult => ({
  ruleId,
  kind: "hard",
  passed: false,
  score: 0,
  reason: { ruleId, kind: "hard", delta, message },
});

export const hardPass = (ruleId: string, message: string): RuleResult => ({
  ruleId,
  kind: "hard",
  passed: true,
  score: 0,
  reason: { ruleId, kind: "hard", delta: 0, message },
});

export const softScore = (ruleId: string, delta: number, message: string): RuleResult => ({
  ruleId,
  kind: "soft",
  passed: true,
  score: delta,
  reason: { ruleId, kind: "soft", delta, message },
});
