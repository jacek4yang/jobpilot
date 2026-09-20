import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../../src/config/schema";
import { createRuleEngine } from "../../../src/domain/engine";
import type { JobDetail } from "../../../src/domain/job/job";
import type { RuleContext, RuleEngineConfig } from "../../../src/domain/rule";
import { asCompanyId, asJobId, asPlatformId, asRecruiterId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;

/**
 * Builds a rule-engine config for a test.
 *
 * Sections are merged shallowly onto the baseline rather than replaced, so an
 * override of one field cannot silently reset its siblings (in particular
 * `minSalaryK`, which `soft.salary-quality` uses as its baseline and would
 * otherwise inject a constant +12 into every score).
 */
const config = (overrides: Partial<RuleEngineConfig> = {}): RuleEngineConfig => {
  const base = createDefaultConfig();
  return {
    hard: {
      ...base.filters,
      // Keep the salary-quality contribution neutral unless a test opts in.
      minSalaryK: 0,
      ...overrides.hard,
    },
    scoring: {
      ...base.scoring,
      baseScore: 50,
      acceptThreshold: 60,
      ...overrides.scoring,
    },
  };
};

/** Overrides a subset of scoring fields without dropping the rest. */
const mergeScoring = (
  partial: Partial<RuleEngineConfig["scoring"]>,
): RuleEngineConfig["scoring"] => ({
  ...createDefaultConfig().scoring,
  ...partial,
});

/** Overrides a subset of hard-filter fields without dropping the rest. */
const mergeHard = (partial: Partial<RuleEngineConfig["hard"]>): RuleEngineConfig["hard"] => ({
  ...createDefaultConfig().filters,
  minSalaryK: 0,
  ...partial,
});

const job = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  id: asJobId("job-1"),
  platform: asPlatformId("boss"),
  title: "前端开发工程师",
  companyName: "示例科技",
  locationRaw: "北京·朝阳区",
  salaryRaw: "25-40K",
  idIsPlatformNative: true,
  company: { id: asCompanyId("示例科技"), name: "示例科技" },
  salary: { period: "month", raw: "25-40K", parsed: true, min: 25, max: 40 },
  location: { city: "北京", district: "朝阳区", raw: "北京·朝阳区" },
  education: "bachelor",
  experience: "3-5",
  description: "负责前端开发，使用 TypeScript 和 Vue",
  requirements: ["3年以上经验"],
  skills: ["TypeScript", "Vue"],
  recruiters: [],
  capturedAt: NOW,
  ...overrides,
});

const context = (cfg: RuleEngineConfig, processed: readonly string[] = []): RuleContext => ({
  now: NOW,
  processedJobIds: new Set(processed),
  config: cfg,
});

const evaluate = (j: JobDetail, cfg: RuleEngineConfig, processed: readonly string[] = []) =>
  createRuleEngine(cfg).evaluate({ job: j, context: context(cfg, processed) });

describe("rule engine", () => {
  describe("explainability", () => {
    it("returns reasons alongside the score, never a bare number", () => {
      const cfg = config({
        scoring: {
          baseScore: 50,
          acceptThreshold: 60,
          titleKeywords: [{ keyword: "前端", weight: 20 }],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      const result = evaluate(job(), cfg);
      expect(result.score).toBe(70);
      expect(result.accepted).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.some((reason) => reason.message.includes("前端"))).toBe(true);
    });

    it("explains a rejection caused by the score threshold", () => {
      const result = evaluate(job(), config());
      expect(result.accepted).toBe(false);
      expect(result.reasons.some((reason) => reason.ruleId === "score.threshold")).toBe(true);
    });

    it("explains which hard rule rejected the job", () => {
      const cfg = config({ hard: mergeHard({ cities: ["上海"] }) });
      const result = evaluate(job(), cfg);
      expect(result.accepted).toBe(false);
      expect(result.rejections[0]?.ruleId).toBe("hard.location");
      expect(result.rejections[0]?.message).toContain("北京");
    });
  });

  describe("hard filters", () => {
    it("rejects a job outside the configured cities", () => {
      const cfg = config({ hard: mergeHard({ cities: ["上海"] }) });
      expect(evaluate(job(), cfg).accepted).toBe(false);
    });

    it("accepts a job inside the configured cities", () => {
      const cfg = config({
        hard: mergeHard({ cities: ["北京"] }),
        scoring: mergeScoring({ baseScore: 70, acceptThreshold: 60 }),
      });
      expect(evaluate(job(), cfg).accepted).toBe(true);
    });

    it("normalizes city suffixes so 北京市 matches 北京", () => {
      const cfg = config({ hard: mergeHard({ cities: ["北京市"] }) });
      expect(evaluate(job(), cfg).rejections).toHaveLength(0);
    });

    it("does not reject when the job city is unknown", () => {
      const cfg = config({ hard: mergeHard({ cities: ["上海"] }) });
      const unknownCity = job({ location: { city: "", raw: "" } });
      expect(evaluate(unknownCity, cfg).rejections).toHaveLength(0);
    });

    it("rejects a salary entirely below the minimum", () => {
      // The job's ceiling (18K) is under the configured floor (30K): no overlap.
      const cfg = config({ hard: mergeHard({ minSalaryK: 30 }) });
      const lowPaid = job({
        salary: { period: "month", raw: "12-18K", parsed: true, min: 12, max: 18 },
      });
      expect(evaluate(lowPaid, cfg).rejections[0]?.ruleId).toBe("hard.salary");
    });

    it("accepts a salary range that overlaps the minimum", () => {
      // 25-40K overlaps a 30K floor, so it must not be rejected.
      const cfg = config({ hard: mergeHard({ minSalaryK: 30 }) });
      expect(evaluate(job(), cfg).rejections).toHaveLength(0);
    });

    it("rejects a salary above the maximum", () => {
      const cfg = config({ hard: mergeHard({ maxSalaryK: 10 }) });
      expect(evaluate(job(), cfg).rejections[0]?.ruleId).toBe("hard.salary");
    });

    it("does not reject an unparseable salary", () => {
      const cfg = config({ hard: mergeHard({ minSalaryK: 30 }) });
      const unknown = job({ salary: { period: "unknown", raw: "面议", parsed: false } });
      expect(evaluate(unknown, cfg).rejections).toHaveLength(0);
    });

    it("rejects excluded keywords", () => {
      const cfg = config({ hard: mergeHard({ excludeKeywords: ["外包"] }) });
      const withKeyword = job({ description: "本岗位为外包岗位" });
      expect(evaluate(withKeyword, cfg).rejections[0]?.ruleId).toBe("hard.keywords");
    });

    it("rejects when no required keyword is present", () => {
      const cfg = config({ hard: mergeHard({ includeKeywords: ["React"] }) });
      expect(evaluate(job(), cfg).rejections[0]?.ruleId).toBe("hard.keywords");
    });

    it("accepts when a required keyword is present", () => {
      const cfg = config({ hard: mergeHard({ includeKeywords: ["TypeScript"] }) });
      expect(evaluate(job(), cfg).rejections).toHaveLength(0);
    });

    it("rejects a blacklisted company", () => {
      const cfg = config({ hard: mergeHard({ companyBlacklist: ["示例科技"] }) });
      expect(evaluate(job(), cfg).rejections[0]?.ruleId).toBe("hard.company-blacklist");
    });

    it("rejects a flagged outsourcing company when the rule is on", () => {
      const outsourcing = job({
        company: { id: asCompanyId("外包"), name: "外包公司", isOutsourcing: true },
      });
      const cfg = config();
      expect(evaluate(outsourcing, cfg).rejections[0]?.ruleId).toBe("hard.outsourcing");
    });

    it("does not flag outsourcing when the rule is disabled", () => {
      const outsourcing = job({
        company: { id: asCompanyId("外包"), name: "外包公司", isOutsourcing: true },
      });
      const cfg = config({
        hard: mergeHard({ excludeOutsourcing: false }),
        scoring: mergeScoring({ baseScore: 70, acceptThreshold: 60 }),
      });
      expect(evaluate(outsourcing, cfg).rejections).toHaveLength(0);
    });

    it("rejects a headhunter listing when the rule is on", () => {
      const headhunter = job({
        recruiters: [{ id: asRecruiterId("hh"), name: "某猎头", isHeadhunter: true }],
      });
      const cfg = config({ hard: mergeHard({ excludeHeadhunter: true }) });
      expect(evaluate(headhunter, cfg).rejections[0]?.ruleId).toBe("hard.headhunter");
    });

    it("rejects a job already present in history", () => {
      const result = evaluate(job(), config(), ["job-1"]);
      expect(result.accepted).toBe(false);
      expect(result.rejections[0]?.ruleId).toBe("hard.already-processed");
    });

    it("short-circuits on the first failing hard rule", () => {
      const cfg = config({
        hard: mergeHard({ cities: ["上海"], companyBlacklist: ["示例科技"] }),
      });
      const result = evaluate(job(), cfg);
      // Only the first failure is reported as a rejection, keeping output readable.
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]?.ruleId).toBe("hard.location");
    });
  });

  describe("soft scoring", () => {
    it("sums weighted title keywords", () => {
      const cfg = config({
        scoring: {
          baseScore: 0,
          acceptThreshold: 100,
          titleKeywords: [
            { keyword: "前端", weight: 20 },
            { keyword: "工程师", weight: 10 },
          ],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      expect(evaluate(job(), cfg).score).toBe(30);
    });

    it("scores preferred skills by exact match", () => {
      const cfg = config({
        scoring: {
          baseScore: 0,
          acceptThreshold: 100,
          titleKeywords: [],
          descriptionKeywords: [],
          preferredSkills: [
            { keyword: "TypeScript", weight: 15 },
            { keyword: "Rust", weight: 15 },
          ],
          preferredCities: [],
        },
      });
      expect(evaluate(job(), cfg).score).toBe(15);
    });

    it("scores preferred cities", () => {
      const cfg = config({
        scoring: {
          baseScore: 0,
          acceptThreshold: 100,
          titleKeywords: [],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [{ keyword: "北京", weight: 12 }],
        },
      });
      expect(evaluate(job(), cfg).score).toBe(12);
    });

    it("clamps the score to the 0-100 range", () => {
      const cfg = config({
        scoring: {
          baseScore: 95,
          acceptThreshold: 60,
          titleKeywords: [{ keyword: "前端", weight: 50 }],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      expect(evaluate(job(), cfg).score).toBe(100);
    });

    it("never returns a negative score", () => {
      const cfg = config({
        scoring: {
          baseScore: 0,
          acceptThreshold: 60,
          titleKeywords: [],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      expect(evaluate(job(), cfg).score).toBe(0);
    });

    it("is case-insensitive for keyword matching", () => {
      const cfg = config({
        scoring: {
          baseScore: 0,
          acceptThreshold: 100,
          titleKeywords: [{ keyword: "TYPESCRIPT", weight: 10 }],
          descriptionKeywords: [],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      // The configured keyword is upper-case while the job title is mixed-case.
      const mixedCase = job({ title: "TypeScript Engineer" });
      expect(evaluate(mixedCase, cfg).score).toBe(10);
    });
  });

  describe("determinism", () => {
    it("produces identical output for identical input", () => {
      const cfg = config({
        scoring: {
          baseScore: 50,
          acceptThreshold: 60,
          titleKeywords: [{ keyword: "前端", weight: 20 }],
          descriptionKeywords: [{ keyword: "TypeScript", weight: 5 }],
          preferredSkills: [],
          preferredCities: [],
        },
      });
      const first = evaluate(job(), cfg);
      const second = evaluate(job(), cfg);
      expect(second).toEqual(first);
    });
  });
});
