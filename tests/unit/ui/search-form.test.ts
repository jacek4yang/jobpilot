/**
 * Search form model tests (pure logic).
 *
 * These pin the data transformation the Vue Search page is built on:
 *
 *   - mapping a stored profile (or the config-derived fallback shape) to
 *     editable form values;
 *   - building the persisted profile back from form values: salary parsing
 *     fail-soft, omit-empty semantics, keyword tokenisation, chip state;
 *   - draft resolution: the newest draft wins over stale persisted config, so
 *     a re-render cannot wipe typed values.
 *
 * Profile ids are unique per test so the module-scope draft map never leaks
 * between tests.
 */
import { describe, expect, it } from "vitest";
import type { JobPilotConfig, StoredSearchProfile } from "../../../src/config/schema";
import {
  drafts,
  modelFromProfile,
  profileFromModel,
  resolveProfile,
  resolveProfileId,
  type SearchFormModel,
  salaryValue,
  splitTokens,
} from "../../../src/ui/pages/search/search-form";

const configWithProfile = (id: string, profile?: Partial<StoredSearchProfile>): JobPilotConfig => ({
  general: { enabled: true, locale: "zh-CN", enabledPlatforms: ["boss"], pauseOnNavigation: true },
  filters: {
    cities: [],
    minSalaryK: 0,
    maxSalaryK: 0,
    education: [],
    experience: [],
    includeKeywords: [],
    excludeKeywords: [],
    companyBlacklist: [],
    excludeOutsourcing: false,
    excludeHeadhunter: false,
    skipProcessed: true,
  },
  profiles: [
    {
      id,
      name: "测试意向",
      keywords: [],
      cities: [],
      includeKeywords: [],
      excludeKeywords: [],
      enabled: true,
      ...profile,
    },
  ],
  scoring: {
    baseScore: 0,
    acceptThreshold: 60,
    maxScore: 100,
    titleKeywords: [],
    descriptionKeywords: [],
    preferredSkills: [],
    preferredCities: [],
  },
  automation: {
    mode: "assist",
    acknowledgeRisks: false,
    maxApplicationsPerSession: 20,
    maxApplicationsPerHour: 50,
    maxRetries: 2,
    minActionDelayMs: 800,
    maxActionDelayMs: 2500,
    verifyAfterSubmit: true,
    stopOnUnknownDom: true,
  },
  rateLimit: {
    minNavigationDelayMs: 2000,
    failureBackoffMs: 30_000,
    maxConsecutiveFailures: 3,
    stopOnCircuitBreak: true,
  },
  ui: {
    showPanel: true,
    panelPosition: "bottom-right",
    showReasons: true,
    compactMode: false,
  },
  logging: { level: "info", maxEntries: 500, persistLogs: false, telemetryEnabled: false },
});

const emptyModel = (): SearchFormModel => ({
  keywords: "",
  cities: "",
  salaryMinK: undefined,
  salaryMaxK: undefined,
  experience: [],
  degree: [],
  companyScales: [],
  recruiterActivity: undefined,
  includeKeywords: "",
  excludeKeywords: "",
});

describe("splitTokens", () => {
  it("splits on commas (half- and full-width) and whitespace", () => {
    expect(splitTokens("Java, 后端 微服务")).toEqual(["Java", "后端", "微服务"]);
    expect(splitTokens("北京，上海")).toEqual(["北京", "上海"]);
  });

  it("drops empty tokens and trims", () => {
    expect(splitTokens("  a , ,b  ")).toEqual(["a", "b"]);
    expect(splitTokens("")).toEqual([]);
  });
});

describe("salaryValue", () => {
  it("parses non-negative integers", () => {
    expect(salaryValue("15")).toBe(15);
    expect(salaryValue(" 30 ")).toBe(30);
    expect(salaryValue("0")).toBe(0);
  });

  it("fails soft on empty or non-numeric input", () => {
    expect(salaryValue("")).toBeUndefined();
    expect(salaryValue("   ")).toBeUndefined();
    expect(salaryValue("abc")).toBeUndefined();
    expect(salaryValue("-3")).toBeUndefined();
  });
});

describe("modelFromProfile", () => {
  it("maps a stored profile to editable form values", () => {
    const config = configWithProfile("m-full", {
      keywords: ["Golang", "后端"],
      cities: ["北京", "上海"],
      includeKeywords: ["自研"],
      excludeKeywords: ["外包"],
      salaryMinK: 15,
      salaryMaxK: 30,
      experience: ["3-5年"],
      degree: ["本科"],
      companyScales: ["100-499人"],
      recruiterActivity: "today",
    });

    const model = modelFromProfile(config.profiles[0], config);

    expect(model.keywords).toBe("Golang, 后端");
    expect(model.cities).toBe("北京, 上海");
    expect(model.includeKeywords).toBe("自研");
    expect(model.excludeKeywords).toBe("外包");
    expect(model.salaryMinK).toBe(15);
    expect(model.salaryMaxK).toBe(30);
    expect(model.experience).toEqual(["3-5年"]);
    expect(model.degree).toEqual(["本科"]);
    expect(model.companyScales).toEqual(["100-499人"]);
    expect(model.recruiterActivity).toBe("today");
  });

  it("falls back to the config filters shape when no profile is given", () => {
    const config = configWithProfile("m-unused");
    const withFilters: JobPilotConfig = {
      ...config,
      filters: {
        ...config.filters,
        includeKeywords: ["Golang"],
        cities: ["北京"],
        excludeKeywords: ["外包"],
      },
      profiles: [],
    };

    const model = modelFromProfile(undefined, withFilters);

    expect(model.keywords).toBe("Golang");
    expect(model.cities).toBe("北京");
    expect(model.excludeKeywords).toBe("外包");
    expect(model.includeKeywords).toBe("");
    expect(model.salaryMinK).toBeUndefined();
    expect(model.salaryMaxK).toBeUndefined();
    expect(model.experience).toEqual([]);
    expect(model.degree).toEqual([]);
    expect(model.companyScales).toEqual([]);
    expect(model.recruiterActivity).toBeUndefined();
  });
});

describe("profileFromModel", () => {
  it("round-trips salary 15/30 and tokenised keywords", () => {
    const model: SearchFormModel = {
      ...emptyModel(),
      keywords: "Java, 后端 微服务",
      cities: "北京, 上海",
      salaryMinK: 15,
      salaryMaxK: 30,
    };

    const profile = profileFromModel("p-model", "测试意向", model);

    expect(profile.id).toBe("p-model");
    expect(profile.name).toBe("测试意向");
    expect(profile.enabled).toBe(true);
    expect(profile.keywords).toEqual(["Java", "后端", "微服务"]);
    expect(profile.cities).toEqual(["北京", "上海"]);
    expect(profile.salaryMinK).toBe(15);
    expect(profile.salaryMaxK).toBe(30);
  });

  it("omits empty fields instead of persisting explicit empty values", () => {
    const profile = profileFromModel("p-omit", "默认意向", emptyModel());

    expect(profile.keywords).toEqual([]);
    expect("salaryMinK" in profile).toBe(false);
    expect("salaryMaxK" in profile).toBe(false);
    expect("experience" in profile).toBe(false);
    expect("degree" in profile).toBe(false);
    expect("companyScales" in profile).toBe(false);
    expect("recruiterActivity" in profile).toBe(false);
  });

  it("fails soft on non-finite salary values leaking into the model", () => {
    const profile = profileFromModel("p-nan", "n", {
      ...emptyModel(),
      salaryMinK: Number.NaN,
      salaryMaxK: -5,
    });

    expect("salaryMinK" in profile).toBe(false);
    expect("salaryMaxK" in profile).toBe(false);
  });

  it("round-trips chip state and omits it when empty", () => {
    const withChips = profileFromModel("p-chips", "n", {
      ...emptyModel(),
      experience: ["1-3年"],
      degree: ["本科"],
      companyScales: ["100-499人"],
      recruiterActivity: "today",
    });
    expect(withChips.experience).toEqual(["1-3年"]);
    expect(withChips.degree).toEqual(["本科"]);
    expect(withChips.companyScales).toEqual(["100-499人"]);
    expect(withChips.recruiterActivity).toBe("today");

    const withoutChips = profileFromModel("p-chips-empty", "n", emptyModel());
    expect("experience" in withoutChips).toBe(false);
    expect("recruiterActivity" in withoutChips).toBe(false);
  });
});

describe("draft resolution", () => {
  it("the newest draft wins over a stale persisted profile", () => {
    const config = configWithProfile("p-draft", { keywords: ["stale"] });
    const draft: StoredSearchProfile = {
      id: "p-draft",
      name: "测试意向",
      keywords: ["typed"],
      cities: ["北京"],
      includeKeywords: [],
      excludeKeywords: [],
      enabled: true,
      salaryMinK: 20,
    };
    drafts.set("p-draft", draft);

    expect(resolveProfileId(config)).toBe("p-draft");
    expect(resolveProfile("p-draft", config)).toBe(draft);

    const model = modelFromProfile(resolveProfile("p-draft", config), config);
    expect(model.keywords).toBe("typed");
    expect(model.salaryMinK).toBe(20);
  });

  it("resolves to the enabled profile, or the default fallback id", () => {
    const config = configWithProfile("p-enabled", { keywords: ["persisted"] });
    expect(resolveProfileId(config)).toBe("p-enabled");
    expect(resolveProfile("p-enabled", config)?.keywords).toEqual(["persisted"]);

    const withoutProfiles: JobPilotConfig = { ...config, profiles: [] };
    expect(resolveProfileId(withoutProfiles)).toBe("default-profile");
    const fallback = resolveProfile("default-profile", withoutProfiles);
    expect(fallback.id).toBe("default-profile");
    expect(fallback.name).toBe("默认意向");
  });
});
