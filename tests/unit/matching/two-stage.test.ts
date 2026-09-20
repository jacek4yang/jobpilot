import { describe, expect, it } from "vitest";
import type { JobDetail, JobSummary } from "../../../src/domain/job/job";
import {
  evaluateStageA,
  evaluateStageB,
  type StageBInput,
} from "../../../src/domain/matching/two-stage";
import { parseActivityLabel } from "../../../src/domain/recruiter/activity";
import { createProfile, type SearchProfile } from "../../../src/domain/search-profile/profile";
import { asCompanyId, asJobId, asPlatformId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;

const profile = (overrides: Partial<SearchProfile> = {}): SearchProfile => ({
  ...createProfile({ id: "p1", name: "Test", keywords: ["backend"], cities: [] }),
  ...overrides,
});

const summary = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  id: asJobId("job-1"),
  platform: asPlatformId("boss"),
  title: "Backend Engineer",
  companyName: "Example Corp",
  locationRaw: "北京·朝阳区",
  salaryRaw: "20-35K",
  idIsPlatformNative: true,
  ...overrides,
});

const detail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  ...summary(),
  company: { id: asCompanyId("Example Corp"), name: "Example Corp" },
  salary: { period: "month", raw: "20-35K", parsed: true, min: 20, max: 35 },
  location: { city: "北京", raw: "北京·朝阳区" },
  education: "bachelor",
  experience: "3-5",
  degreeLabel: "本科",
  experienceLabel: "3-5年",
  description: "Build distributed systems in Rust",
  requirements: [],
  skills: ["Rust"],
  recruiters: [],
  capturedAt: NOW,
  ...overrides,
});

const stageA = (overrides: Partial<Parameters<typeof evaluateStageA>[0]> = {}) =>
  evaluateStageA({
    summary: summary(),
    profile: profile(),
    contactedJobIds: new Set<string>(),
    companyBlacklist: [],
    titleBlacklist: [],
    ...overrides,
  });

/**
 * Drops explicitly-undefined values so callers can pass
 * `parseActivityLabel(...)` (which may be undefined) under
 * `exactOptionalPropertyTypes`.
 */
const withoutUndefined = (input: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const stageB = (
  overrides: { readonly [K in keyof StageBInput]?: StageBInput[K] | undefined } = {},
) =>
  evaluateStageB(
    withoutUndefined({
      job: detail(),
      profile: profile(),
      activityPreference: "any",
      skipUnknownActivity: false,
      preferredSkills: [],
      preferredIndustries: [],
      baseScore: 50,
      acceptThreshold: 65,
      ...overrides,
    }) as unknown as StageBInput,
  );

describe("stage A — cheap card filtering", () => {
  it("passes an ordinary job", () => {
    expect(stageA().kind).toBe("passed");
  });

  it("rejects an already-contacted job", () => {
    const result = stageA({ contactedJobIds: new Set(["job-1"]) });
    expect(result.kind).toBe("rejected");
    expect(result.reasons[0]?.code).toBe("ALREADY_CONTACTED");
  });

  it("rejects an excluded keyword in the card text", () => {
    const result = stageA({ profile: profile({ excludeKeywords: ["Engineer"] }) });
    expect(result.kind).toBe("rejected");
  });

  it("rejects a blacklisted company", () => {
    const result = stageA({ companyBlacklist: ["Example"] });
    expect(result.kind).toBe("rejected");
  });

  it("rejects a blacklisted title", () => {
    const result = stageA({ titleBlacklist: ["Engineer"] });
    expect(result.kind).toBe("rejected");
  });

  it("rejects a job outside the profile cities", () => {
    const result = stageA({ profile: profile({ cities: ["上海"] }) });
    expect(result.kind).toBe("rejected");
  });

  it("passes a job in a listed city regardless of suffix", () => {
    const result = stageA({ profile: profile({ cities: ["北京市"] }) });
    expect(result.kind).toBe("passed");
  });

  it("rejects a card salary entirely below the profile minimum", () => {
    const result = stageA({
      summary: summary({ salaryRaw: "8-12K" }),
      profile: profile({ salary: { minK: 20, maxK: 0 } }),
    });
    expect(result.kind).toBe("rejected");
  });

  it("does NOT reject an unparseable salary, because the card may omit it", () => {
    const result = stageA({
      summary: summary({ salaryRaw: "面议" }),
      profile: profile({ salary: { minK: 20, maxK: 0 } }),
    });
    expect(result.kind).toBe("passed");
  });

  it("uses only card data, so it never needs the detail page", () => {
    // This is the performance property that makes stage A worth having: a
    // rejected job is never opened.
    const result = stageA({ profile: profile({ excludeKeywords: ["Backend"] }) });
    expect(result.kind).toBe("rejected");
    expect(result.reasons.every((reason) => reason.stage === "A")).toBe(true);
  });
});

describe("stage B — detail evaluation", () => {
  it("accepts a job that scores above the threshold", () => {
    const result = stageB({
      preferredSkills: [{ keyword: "Rust", weight: 20 }],
      baseScore: 50,
      acceptThreshold: 65,
    });
    expect(result.accepted).toBe(true);
    // base 50 + activity pass 10 + skill 20
    expect(result.score).toBe(80);
  });

  it("rejects a job that scores below the threshold, explaining why", () => {
    const result = stageB({ baseScore: 10, acceptThreshold: 65 });
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.code === "score-threshold")).toBe(true);
  });

  it("rejects when no required keyword is present", () => {
    const result = stageB({ profile: profile({ includeKeywords: ["Kubernetes"] }) });
    expect(result.outcome.kind).toBe("rejected");
    expect(result.reasons[0]?.code).toBe("FILTER_REJECTED");
  });

  it("passes when a required keyword is present", () => {
    const result = stageB({ profile: profile({ includeKeywords: ["Rust"] }), acceptThreshold: 0 });
    expect(result.outcome.kind).toBe("passed");
  });

  it("rejects an excluded keyword found only in the description", () => {
    const result = stageB({
      job: detail({ description: "This is an outsourcing role" }),
      profile: profile({ excludeKeywords: ["outsourcing"] }),
    });
    expect(result.outcome.kind).toBe("rejected");
  });

  it("checks hard filters before scoring, short-circuiting", () => {
    const result = stageB({
      profile: profile({ excludeKeywords: ["Rust"] }),
      preferredSkills: [{ keyword: "Rust", weight: 50 }],
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(1);
  });
});

describe("stage B — degree and experience", () => {
  it("rejects a degree outside the accepted set", () => {
    const result = stageB({
      job: detail({ degreeLabel: "硕士" }),
      profile: profile({ degree: ["本科"] }),
    });
    expect(result.outcome.kind).toBe("rejected");
  });

  it("accepts a degree in the set", () => {
    const result = stageB({
      job: detail({ degreeLabel: "本科" }),
      profile: profile({ degree: ["本科", "硕士"] }),
      acceptThreshold: 0,
    });
    expect(result.outcome.kind).toBe("passed");
  });

  it("treats 不限 as accepting every degree", () => {
    const result = stageB({
      job: detail({ degreeLabel: "博士" }),
      profile: profile({ degree: ["不限"] }),
      acceptThreshold: 0,
    });
    expect(result.outcome.kind).toBe("passed");
  });

  it("does not reject when the posting omits the degree", () => {
    const result = stageB({
      job: (() => {
        const j = detail();
        const { degreeLabel: _omit, ...rest } = j;
        return rest as typeof j;
      })(),
      profile: profile({ degree: ["本科"] }),
      acceptThreshold: 0,
    });
    expect(result.outcome.kind).toBe("passed");
  });

  it("rejects an experience band outside the accepted set", () => {
    const result = stageB({
      job: detail({ experienceLabel: "10年以上" }),
      profile: profile({ experience: ["3-5年"] }),
    });
    expect(result.outcome.kind).toBe("rejected");
  });

  it("accepts 经验不限 as accepting every band", () => {
    const result = stageB({
      job: detail({ experienceLabel: "10年以上" }),
      profile: profile({ experience: ["经验不限"] }),
      acceptThreshold: 0,
    });
    expect(result.outcome.kind).toBe("passed");
  });
});

describe("stage B — activity integration", () => {
  it("rejects when the recruiter falls outside the preference", () => {
    const result = stageB({
      activity: parseActivityLabel("半年前活跃"),
      activityPreference: "today",
      skipUnknownActivity: true,
    });
    expect(result.outcome.kind).toBe("rejected");
  });

  it("rejects unknown activity when the policy says to skip it", () => {
    const result = stageB({
      activityPreference: "today",
      skipUnknownActivity: true,
    });
    expect(result.outcome.kind).toBe("rejected");
  });

  it("allows unknown activity when the policy permits it", () => {
    const result = stageB({
      activityPreference: "today",
      skipUnknownActivity: false,
      acceptThreshold: 0,
    });
    expect(result.outcome.kind).toBe("passed");
  });

  it("adds a reason when activity passes", () => {
    const result = stageB({
      activity: parseActivityLabel("在线"),
      activityPreference: "online",
    });
    expect(result.reasons.some((reason) => reason.code === "activity")).toBe(true);
  });
});

describe("stage B — scoring contributions", () => {
  it("weights preferred skills", () => {
    const withSkill = stageB({ preferredSkills: [{ keyword: "Rust", weight: 15 }] });
    const without = stageB({ preferredSkills: [] });
    expect(withSkill.score).toBe(without.score + 15);
  });

  it("does not award a skill that is absent", () => {
    const result = stageB({ preferredSkills: [{ keyword: "COBOL", weight: 15 }] });
    expect(result.reasons.some((reason) => reason.code === "skill:COBOL")).toBe(false);
  });

  it("weights preferred industries from the company record", () => {
    const result = stageB({
      job: detail({
        company: { id: asCompanyId("x"), name: "Example Corp", industry: "Fintech" },
      }),
      preferredIndustries: [{ keyword: "Fintech", weight: 15 }],
    });
    expect(result.reasons.some((reason) => reason.code === "industry:Fintech")).toBe(true);
  });

  it("awards salary above target", () => {
    const result = stageB({ profile: profile({ salary: { minK: 15, maxK: 0 } }) });
    expect(result.reasons.some((reason) => reason.code === "salary-above-target")).toBe(true);
  });

  it("awards a matching company scale", () => {
    const result = stageB({
      job: detail({
        company: { id: asCompanyId("x"), name: "Example Corp", size: "100-499人" },
      }),
      profile: profile({ companyScales: ["100-499人"] }),
    });
    expect(result.reasons.some((reason) => reason.code === "company-scale")).toBe(true);
  });

  it("clamps the score to 100", () => {
    const result = stageB({
      baseScore: 95,
      preferredSkills: [{ keyword: "Rust", weight: 50 }],
      acceptThreshold: 65,
    });
    expect(result.score).toBe(100);
  });

  it("never returns a negative score", () => {
    // Even with a zero base, an "any" activity preference contributes its
    // bonus; the clamp still keeps the result inside 0..100.
    const result = stageB({ baseScore: 0, acceptThreshold: 200 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("gives every contribution a signed delta and a typed code", () => {
    const result = stageB({
      preferredSkills: [{ keyword: "Rust", weight: 20 }],
      preferredIndustries: [{ keyword: "Fintech", weight: 10 }],
      activity: parseActivityLabel("在线"),
      activityPreference: "online",
      job: detail({
        company: { id: asCompanyId("x"), name: "Example Corp", industry: "Fintech" },
      }),
    });
    for (const reason of result.reasons) {
      expect(typeof reason.code).toBe("string");
      expect(reason.code.length).toBeGreaterThan(0);
      expect(Number.isFinite(reason.delta)).toBe(true);
    }
    // The score must equal the sum of the deltas, so the explanation is honest.
    const summed = result.reasons.reduce((total, reason) => total + reason.delta, 0) + 50;
    expect(result.score).toBe(Math.min(100, Math.max(0, Math.round(summed))));
  });
});

describe("stage separation", () => {
  it("tags reasons with the stage that produced them", () => {
    const a = stageA({ profile: profile({ cities: ["北京"] }) });
    const b = stageB({ profile: profile({ cities: ["北京"] }) });
    expect(a.reasons.every((reason) => reason.stage === "A")).toBe(true);
    expect(b.reasons.every((reason) => reason.stage === "B")).toBe(true);
  });
});
