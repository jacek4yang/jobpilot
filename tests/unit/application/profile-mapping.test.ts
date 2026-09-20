import { describe, expect, it } from "vitest";
import {
  profileToWeights,
  toDomainProfile,
  toStoredProfile,
} from "../../../src/application/profile-mapping";
import type { StoredSearchProfile } from "../../../src/config/schema";
import { createProfile } from "../../../src/domain/search-profile/profile";

const stored = (overrides: Partial<StoredSearchProfile> = {}): StoredSearchProfile => ({
  id: "p1",
  name: "Rust Backend",
  keywords: ["rust"],
  cities: ["北京"],
  includeKeywords: ["tokio"],
  excludeKeywords: ["外包"],
  enabled: true,
  ...overrides,
});

describe("profile mapping", () => {
  describe("stored -> domain", () => {
    it("carries the scalar fields across", () => {
      const profile = toDomainProfile(stored());
      expect(profile.id).toBe("p1");
      expect(profile.name).toBe("Rust Backend");
      expect(profile.keywords).toEqual(["rust"]);
      expect(profile.cities).toEqual(["北京"]);
      expect(profile.includeKeywords).toEqual(["tokio"]);
      expect(profile.excludeKeywords).toEqual(["外包"]);
      expect(profile.enabled).toBe(true);
    });

    it("builds a salary preference only when a bound is present", () => {
      expect(toDomainProfile(stored()).salary).toBeUndefined();
      expect(toDomainProfile(stored({ salaryMinK: 25 })).salary).toEqual({ minK: 25, maxK: 0 });
      expect(toDomainProfile(stored({ salaryMaxK: 60 })).salary).toEqual({ minK: 0, maxK: 60 });
    });

    it("keeps only valid union members for degree", () => {
      const profile = toDomainProfile(stored({ degree: ["本科", "not-a-degree", "硕士"] }));
      expect(profile.degree).toEqual(["本科", "硕士"]);
    });

    it("keeps only valid union members for experience", () => {
      const profile = toDomainProfile(stored({ experience: ["3-5年", "nonsense"] }));
      expect(profile.experience).toEqual(["3-5年"]);
    });

    it("keeps only valid union members for company scale", () => {
      const profile = toDomainProfile(stored({ companyScales: ["100-499人", "huge"] }));
      expect(profile.companyScales).toEqual(["100-499人"]);
    });

    it("drops a filter entirely when no value survived validation", () => {
      // Dropping narrows rather than widens, which is the safe direction: a
      // typo must not turn into an unintended match.
      const profile = toDomainProfile(stored({ degree: ["bogus"] }));
      expect(profile.degree).toBeUndefined();
    });

    it("drops an unrecognised activity preference", () => {
      expect(
        toDomainProfile(stored({ recruiterActivity: "yesterday" })).recruiterActivity,
      ).toBeUndefined();
      expect(toDomainProfile(stored({ recruiterActivity: "today" })).recruiterActivity).toBe(
        "today",
      );
    });

    it("does not add optional keys that were absent", () => {
      const profile = toDomainProfile(stored());
      expect("degree" in profile).toBe(false);
      expect("salary" in profile).toBe(false);
      expect("recruiterActivity" in profile).toBe(false);
    });
  });

  describe("domain -> stored", () => {
    it("round-trips a fully specified profile", () => {
      const original = createProfile({
        id: "p1",
        name: "Rust",
        keywords: ["rust"],
        cities: ["北京"],
        includeKeywords: ["tokio"],
        excludeKeywords: ["外包"],
        salary: { minK: 25, maxK: 60 },
        degree: ["本科"],
        experience: ["3-5年"],
        companyScales: ["100-499人"],
        recruiterActivity: "today",
        skipUnknownActivity: true,
      });

      const back = toDomainProfile(toStoredProfile(original));

      expect(back.id).toBe(original.id);
      expect(back.keywords).toEqual(original.keywords);
      expect(back.cities).toEqual(original.cities);
      expect(back.salary).toEqual(original.salary);
      expect(back.degree).toEqual(original.degree);
      expect(back.experience).toEqual(original.experience);
      expect(back.companyScales).toEqual(original.companyScales);
      expect(back.recruiterActivity).toBe(original.recruiterActivity);
      expect(back.skipUnknownActivity).toBe(true);
    });

    it("omits absent optional sections", () => {
      const persisted = toStoredProfile(createProfile({ id: "p", name: "Bare" }));
      expect("salaryMinK" in persisted).toBe(false);
      expect("degree" in persisted).toBe(false);
      expect("recruiterActivity" in persisted).toBe(false);
    });
  });

  describe("keyword weights", () => {
    it("turns profile keywords into title weights", () => {
      const weights = profileToWeights(createProfile({ id: "p", name: "n", keywords: ["rust"] }));
      expect(weights.title).toEqual([{ keyword: "rust", weight: 15 }]);
    });

    it("turns include-keywords into description weights", () => {
      const weights = profileToWeights(
        createProfile({ id: "p", name: "n", includeKeywords: ["tokio"] }),
      );
      expect(weights.description).toEqual([{ keyword: "tokio", weight: 10 }]);
    });

    it("produces empty weight lists for a bare profile", () => {
      const weights = profileToWeights(createProfile({ id: "p", name: "n" }));
      expect(weights.title).toEqual([]);
      expect(weights.description).toEqual([]);
    });
  });
});
