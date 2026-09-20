import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PREFERENCES,
  COMPANY_SCALES,
  createProfile,
  DEGREE_LEVELS,
  duplicateProfile,
  EXPERIENCE_BANDS,
} from "../../../src/domain/search-profile/profile";
import {
  isKnownCity,
  listCityNames,
  NATIONWIDE_CITY_CODE,
  normalizeCityName,
  resolveCityCode,
  resolveCityCodes,
} from "../../../src/adapters/boss/data/city-resolver";
import { createMemoryLock, DEFAULT_LOCK_TTL_MS } from "../../../src/ports/lock";
import type { Clock } from "../../../src/domain/support/shared";

const NOW = 1_700_000_000_000;

const fakeClock = (start = NOW): Clock & { advance: (ms: number) => void } => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

describe("search profiles", () => {
  describe("creation", () => {
    it("defaults to empty keyword lists, not opinionated ones", () => {
      const profile = createProfile({ id: "p", name: "New" });
      expect(profile.includeKeywords).toEqual([]);
      expect(profile.excludeKeywords).toEqual([]);
      expect(profile.keywords).toEqual([]);
      expect(profile.cities).toEqual([]);
    });

    it("is enabled by default", () => {
      expect(createProfile({ id: "p", name: "New" }).enabled).toBe(true);
    });

    it("trims the name", () => {
      expect(createProfile({ id: "p", name: "  Rust  " }).name).toBe("Rust");
    });

    it("omits optional sections rather than storing undefined", () => {
      const profile = createProfile({ id: "p", name: "New" });
      expect("salary" in profile).toBe(false);
      expect("degree" in profile).toBe(false);
    });

    it("keeps supplied filters", () => {
      const profile = createProfile({
        id: "p",
        name: "Rust",
        keywords: ["rust"],
        cities: ["北京"],
        degree: ["本科"],
        experience: ["3-5年"],
        companyScales: ["100-499人"],
        recruiterActivity: "today",
      });
      expect(profile.degree).toEqual(["本科"]);
      expect(profile.companyScales).toEqual(["100-499人"]);
      expect(profile.recruiterActivity).toBe("today");
    });
  });

  describe("duplication", () => {
    it("creates a copy with a distinct id and name", () => {
      const original = createProfile({ id: "a", name: "Rust" });
      const copy = duplicateProfile(original, "b", ["Rust"]);
      expect(copy.id).toBe("b");
      expect(copy.name).toBe("Rust copy");
    });

    it("avoids name collisions", () => {
      const original = createProfile({ id: "a", name: "Rust" });
      const copy = duplicateProfile(original, "c", ["Rust", "Rust copy"]);
      expect(copy.name).toBe("Rust copy 2");
    });

    it("preserves the filters", () => {
      const original = createProfile({ id: "a", name: "Rust", cities: ["北京"] });
      expect(duplicateProfile(original, "b", []).cities).toEqual(["北京"]);
    });
  });

  describe("vocabularies", () => {
    it("uses BOSS's own degree strings", () => {
      expect(DEGREE_LEVELS).toContain("大专");
      expect(DEGREE_LEVELS).toContain("本科");
      expect(DEGREE_LEVELS).toContain("硕士");
      expect(DEGREE_LEVELS).toContain("不限");
    });

    it("exposes the documented experience bands", () => {
      expect(EXPERIENCE_BANDS).toContain("应届生");
      expect(EXPERIENCE_BANDS).toContain("经验不限");
    });

    it("exposes the documented company scales", () => {
      expect(COMPANY_SCALES).toContain("100-499人");
    });

    it("exposes the activity preferences", () => {
      expect(ACTIVITY_PREFERENCES).toContain("any");
      expect(ACTIVITY_PREFERENCES).toContain("online");
    });
  });
});

describe("city resolution", () => {
  describe("the vendored table", () => {
    it("contains a useful number of cities", () => {
      expect(listCityNames().length).toBeGreaterThan(300);
    });

    it("includes 全国", () => {
      expect(resolveCityCode("全国").ok).toBe(true);
      const result = resolveCityCode("全国");
      if (result.ok) expect(result.code).toBe(NATIONWIDE_CITY_CODE);
    });

    it("includes minor cities, not just tier-1", () => {
      expect(isKnownCity("楚雄彝族自治州")).toBe(true);
      expect(isKnownCity("大庆")).toBe(true);
    });
  });

  describe("exact and normalised matches", () => {
    it("resolves an exact name", () => {
      const result = resolveCityCode("北京");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.code).toMatch(/^\d{9}$/);
    });

    it("resolves a name with a 市 suffix", () => {
      const direct = resolveCityCode("北京");
      const suffixed = resolveCityCode("北京市");
      expect(suffixed.ok).toBe(true);
      if (direct.ok && suffixed.ok) {
        expect(suffixed.code).toBe(direct.code);
        expect(suffixed.normalized).toBe(true);
      }
    });

    it("resolves an autonomous-prefecture name containing 自治州", () => {
      // The table is city-level, so 自治州 / 地区 names resolve directly and
      // their suffix must not be stripped into a non-existent shorter name.
      expect(resolveCityCode("楚雄彝族自治州").ok).toBe(true);
    });

    it("does not invent province-level entries that the table does not contain", () => {
      // BOSS's table is a city taxonomy; a bare province name is genuinely
      // unknown and must fail rather than resolving to its capital.
      const result = resolveCityCode("广东省");
      expect(result.ok).toBe(false);
    });

    it("accepts a bare 9-digit code that exists in the table", () => {
      const result = resolveCityCode(NATIONWIDE_CITY_CODE);
      expect(result.ok).toBe(true);
    });

    it("normalises suffixes without over-stripping", () => {
      expect(normalizeCityName("北京市")).toBe("北京");
      expect(normalizeCityName("北京")).toBe("北京");
      // A short name must not be reduced to nothing.
      expect(normalizeCityName("市").length).toBeGreaterThan(0);
    });
  });

  describe("explicit failure — never a default city", () => {
    it("fails on an unknown city rather than defaulting", () => {
      const result = resolveCityCode("不存在的城市");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unknown");
    });

    it("fails on an empty city", () => {
      const result = resolveCityCode("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("empty");
    });

    it("fails on a numeric string that is not a known code", () => {
      const result = resolveCityCode("999999999");
      expect(result.ok).toBe(false);
    });

    it("offers suggestions instead of guessing", () => {
      const result = resolveCityCode("楚雄");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.suggestions).toContain("楚雄彝族自治州");
    });

    it("never silently returns a different city", () => {
      const result = resolveCityCode("Atlantis");
      expect(result.ok).toBe(false);
    });
  });

  describe("batch resolution", () => {
    it("partitions successes from failures", () => {
      const { resolved, failed } = resolveCityCodes(["北京", "不存在的城市", "上海"]);
      expect(resolved).toHaveLength(2);
      expect(failed).toHaveLength(1);
    });

    it("preserves the caller's original input in each result", () => {
      const { resolved } = resolveCityCodes(["北京市"]);
      expect(resolved[0]?.input).toBe("北京市");
    });
  });
});

describe("cross-tab lock", () => {
  it("grants the lock when free", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    const result = await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    expect(result.ok).toBe(true);
  });

  it("denies a second owner while held", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    const second = await lock.acquire({ ownerId: "tab-b", ttlMs: DEFAULT_LOCK_TTL_MS });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("held-by-other");
      expect(second.holder).toBe("tab-a");
    }
  });

  it("allows another tab to acquire after an explicit release", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    const first = await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    if (first.ok) await lock.release(first.handle.token);
    const second = await lock.acquire({ ownerId: "tab-b", ttlMs: DEFAULT_LOCK_TTL_MS });
    expect(second.ok).toBe(true);
  });

  it("reclaims an expired lease so a crashed tab cannot wedge the app", async () => {
    const clock = fakeClock();
    const lock = createMemoryLock({ clock });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 1_000 });
    clock.advance(1_001);
    const second = await lock.acquire({ ownerId: "tab-b", ttlMs: 1_000 });
    expect(second.ok).toBe(true);
  });

  it("renews only for the current holder", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 5_000 });
    expect(await lock.renew({ token: "tab-a", ttlMs: 5_000 })).toBe(true);
    expect(await lock.renew({ token: "tab-b", ttlMs: 5_000 })).toBe(false);
  });

  it("keeps the lease alive across renewals", async () => {
    const clock = fakeClock();
    const lock = createMemoryLock({ clock });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 1_000 });
    clock.advance(900);
    await lock.renew({ token: "tab-a", ttlMs: 1_000 });
    clock.advance(900);
    // Still held, because the renewal pushed the expiry out.
    const second = await lock.acquire({ ownerId: "tab-b", ttlMs: 1_000 });
    expect(second.ok).toBe(false);
  });

  it("does not release someone else's lock", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    await lock.release("tab-b");
    expect(await lock.currentHolder()).toBe("tab-a");
  });

  it("reports the current holder", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    expect(await lock.currentHolder()).toBeUndefined();
    await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    expect(await lock.currentHolder()).toBe("tab-a");
  });

  it("treats a seeded foreign holder as busy", async () => {
    const lock = createMemoryLock({ clock: fakeClock(), seedHolder: "other-tab" });
    const result = await lock.acquire({ ownerId: "tab-a", ttlMs: DEFAULT_LOCK_TTL_MS });
    expect(result.ok).toBe(false);
  });

  it("is safe to release when not held", async () => {
    const lock = createMemoryLock({ clock: fakeClock() });
    await expect(lock.release("nobody")).resolves.toBeUndefined();
  });
});
