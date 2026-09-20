import { describe, expect, it } from "vitest";
import {
  acceptedJobIds,
  acceptedMatches,
  createDiscoveryService,
  type DiscoveryDeps,
  formatReasons,
} from "../../../src/application/discovery";
import type { JobDetail, JobSummary } from "../../../src/domain/job/job";
import { createProfile } from "../../../src/domain/search-profile/profile";
import { asCompanyId, asJobId, asPlatformId } from "../../../src/domain/support/ids";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";
import type { JobPlatform, PageKind } from "../../../src/ports/job-platform";
import type { Logger } from "../../../src/ports/logger";

const NOW = 1_700_000_000_000;

const summary = (id: string, overrides: Partial<JobSummary> = {}): JobSummary => ({
  id: asJobId(id),
  platform: asPlatformId("boss"),
  title: "Backend Engineer",
  companyName: "Example Corp",
  locationRaw: "北京·朝阳区",
  salaryRaw: "20-35K",
  idIsPlatformNative: true,
  ...overrides,
});

const detailFor = (s: JobSummary): JobDetail => ({
  ...s,
  company: { id: asCompanyId(s.companyName), name: s.companyName },
  salary: { period: "month", raw: s.salaryRaw, parsed: true, min: 20, max: 35 },
  location: { city: "北京", raw: s.locationRaw },
  education: "bachelor",
  experience: "3-5",
  degreeLabel: "本科",
  description: "Build distributed systems",
  requirements: [],
  skills: ["Rust"],
  recruiters: [],
  capturedAt: NOW,
});

/** Records every call so tests can assert what was (not) touched. */
const recordingPlatform = (
  options: {
    readonly pageKind?: PageKind;
    readonly jobs?: readonly JobSummary[];
    readonly failLoad?: ReadonlySet<string>;
    readonly scanThrows?: string;
  } = {},
): JobPlatform & { readonly loaded: string[]; readonly scans: number } => {
  const loaded: string[] = [];
  let scans = 0;
  const jobs = options.jobs ?? [];

  return {
    id: "boss",
    displayName: "BOSS Zhipin",
    detectPage: () => options.pageKind ?? "job-list",
    scanJobs: async () => {
      scans += 1;
      if (options.scanThrows !== undefined) throw new Error(options.scanThrows);
      return jobs;
    },
    loadJob: async (s) => {
      loaded.push(String(s.id));
      if (options.failLoad?.has(String(s.id)) === true) throw new Error("detail did not render");
      return detailFor(s);
    },
    apply: async () => ({
      outcome: { kind: "blocked", reason: "unknown-dom", evidence: "n/a" },
      jobId: "",
    }),
    verifyApplication: async () => ({
      outcome: { kind: "indeterminate", evidence: "n/a" },
      jobId: "",
    }),
    get loaded() {
      return loaded;
    },
    get scans() {
      return scans;
    },
  };
};

const deps = (overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps => ({
  platform: recordingPlatform(),
  logger: createNullLogger() as Logger,
  resolveCities: () => ({ ok: true, codes: [] }),
  contactedJobIds: new Set<string>(),
  companyBlacklist: [],
  titleBlacklist: [],
  scoring: {
    baseScore: 50,
    acceptThreshold: 65,
    preferredSkills: [],
    preferredIndustries: [],
  },
  activityPreference: "any",
  skipUnknownActivity: false,
  readActivity: () => undefined,
  ...overrides,
});

const profile = () => createProfile({ id: "p", name: "Test" });

describe("discovery service", () => {
  describe("fail-closed gating", () => {
    for (const pageKind of ["captcha", "login-required", "unsupported", "unknown"] as const) {
      it(`refuses to scan a ${pageKind} page`, async () => {
        const platform = recordingPlatform({ pageKind });
        const service = createDiscoveryService(deps({ platform }));
        const result = await service.run(profile());
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.kind).toBe("page-kind");
        // Nothing was scanned or opened.
        expect(platform.scans).toBe(0);
        expect(platform.loaded).toEqual([]);
      });
    }
  });

  describe("city validation", () => {
    it("stops when a profile city is unknown, rather than searching elsewhere", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(
        deps({
          platform,
          resolveCities: () => ({ ok: false, city: "楚雄", suggestions: ["楚雄彝族自治州"] }),
        }),
      );
      const result = await service.run(createProfile({ id: "p", name: "T", cities: ["楚雄"] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe("city");
        if (result.failure.kind === "city") {
          expect(result.failure.suggestions).toContain("楚雄彝族自治州");
        }
      }
      // The critical property: no scan happened with a substituted city.
      expect(platform.scans).toBe(0);
    });
  });

  describe("early exits", () => {
    it("reports no-jobs when the listing is empty", async () => {
      const service = createDiscoveryService(deps({ platform: recordingPlatform({ jobs: [] }) }));
      const result = await service.run(profile());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("no-jobs");
    });

    it("reports an error when the scan throws", async () => {
      const service = createDiscoveryService(
        deps({ platform: recordingPlatform({ scanThrows: "dom changed" }) }),
      );
      const result = await service.run(profile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe("error");
        if (result.failure.kind === "error") expect(result.failure.message).toBe("dom changed");
      }
    });

    it("respects an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(deps({ platform, signal: controller.signal }));
      const result = await service.run(profile());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("aborted");
      expect(platform.scans).toBe(0);
    });
  });

  describe("stage separation", () => {
    it("does not open a job that stage A rejects", async () => {
      const platform = recordingPlatform({
        jobs: [summary("keep"), summary("drop", { title: "Sales Manager" })],
      });
      const service = createDiscoveryService(
        deps({ platform, contactedJobIds: new Set(["drop"]) }),
      );

      const result = await service.run(profile());
      expect(result.ok).toBe(true);
      // The decisive performance property: the rejected job was never opened.
      expect(platform.loaded).toEqual(["keep"]);
    });

    it("records stage A rejections with a reason", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(deps({ platform, companyBlacklist: ["Example"] }));
      const result = await service.run(profile());
      if (result.ok) {
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.accepted).toBe(false);
        expect(result.matches[0]?.decidedAt).toBe("A");
        expect(result.matches[0]?.reasons.length).toBeGreaterThan(0);
      }
    });

    it("does not open anything when every job fails stage A", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1"), summary("j2")] });
      const service = createDiscoveryService(deps({ platform, companyBlacklist: ["Example"] }));
      await service.run(profile());
      expect(platform.loaded).toEqual([]);
    });
  });

  describe("detail failures", () => {
    it("records an unopenable job as a rejection rather than dropping it", async () => {
      const platform = recordingPlatform({
        jobs: [summary("good"), summary("bad")],
        failLoad: new Set(["bad"]),
      });
      const service = createDiscoveryService(deps({ platform }));
      const result = await service.run(profile());

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Both jobs are represented, so the user can see why one is missing.
        expect(result.matches).toHaveLength(2);
        const bad = result.matches.find((match) => String(match.summary.id) === "bad");
        expect(bad?.accepted).toBe(false);
        expect(bad?.reasons[0]?.code).toBe("DETAIL_TIMEOUT");
      }
    });

    it("continues after one job fails to open", async () => {
      const platform = recordingPlatform({
        jobs: [summary("bad"), summary("good")],
        failLoad: new Set(["bad"]),
      });
      const service = createDiscoveryService(deps({ platform }));
      const result = await service.run(profile());
      expect(platform.loaded).toEqual(["bad", "good"]);
      if (result.ok) expect(result.matches).toHaveLength(2);
    });
  });

  describe("scoring", () => {
    it("accepts a job above the threshold", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(
        deps({
          platform,
          scoring: {
            baseScore: 50,
            acceptThreshold: 65,
            preferredSkills: [{ keyword: "Rust", weight: 20 }],
            preferredIndustries: [],
          },
        }),
      );
      const result = await service.run(profile());
      if (result.ok) expect(result.matches[0]?.accepted).toBe(true);
    });

    it("rejects a job below the threshold, with an explanation", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(
        deps({
          platform,
          scoring: {
            baseScore: 10,
            acceptThreshold: 90,
            preferredSkills: [],
            preferredIndustries: [],
          },
        }),
      );
      const result = await service.run(profile());
      if (result.ok) {
        expect(result.matches[0]?.accepted).toBe(false);
        expect(result.matches[0]?.reasons.some((r) => r.code === "score-threshold")).toBe(true);
      }
    });

    it("never enqueues: it returns matches only", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(deps({ platform }));
      const result = await service.run(profile());
      // The result shape has no queue, which is the structural guarantee that
      // discovery cannot start contacting jobs on its own.
      expect(result.ok && "matches" in result).toBe(true);
      expect(result.ok && "queued" in result).toBe(false);
    });
  });

  describe("activity integration", () => {
    it("passes the read activity into stage B", async () => {
      const platform = recordingPlatform({ jobs: [summary("j1")] });
      const service = createDiscoveryService(
        deps({
          platform,
          activityPreference: "online",
          skipUnknownActivity: true,
          readActivity: () => ({
            label: "半年前活跃",
            recency: "inactive",
            days: Number.POSITIVE_INFINITY,
            online: false,
          }),
        }),
      );
      const result = await service.run(profile());
      if (result.ok) expect(result.matches[0]?.accepted).toBe(false);
    });
  });

  describe("helpers", () => {
    it("filters accepted matches", () => {
      const matches = [
        { summary: summary("a"), accepted: true, score: 80, reasons: [], decidedAt: "B" as const },
        { summary: summary("b"), accepted: false, score: 10, reasons: [], decidedAt: "B" as const },
      ];
      expect(acceptedMatches(matches)).toHaveLength(1);
      expect(acceptedJobIds(matches).has("a")).toBe(true);
      expect(acceptedJobIds(matches).has("b")).toBe(false);
    });

    it("formats positive and negative contributions legibly", () => {
      const formatted = formatReasons([
        { code: "s", stage: "B", message: "Rust present", delta: 20 },
        { code: "n", stage: "B", message: "degree mismatch", delta: -5 },
      ]);
      expect(formatted[0]).toBe("+20 Rust present");
      expect(formatted[1]).toBe("-5 degree mismatch");
    });
  });
});
