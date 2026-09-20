import { describe, expect, it } from "vitest";
import {
  blocksFurtherContact,
  contactedSince,
  createJobHistory,
  deserializeJobHistory,
} from "../../../src/domain/history/job-history";
import { asJobId, asPlatformId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;
const platform = asPlatformId("boss");
const jobId = asJobId("job-1");

const entry = (
  overrides: Partial<Parameters<ReturnType<typeof createJobHistory>["record"]>[0]> = {},
) => ({
  jobId,
  platform,
  title: "Backend Engineer",
  company: "Example Corp",
  outcome: "contacted" as const,
  now: NOW,
  ...overrides,
});

describe("job history", () => {
  describe("recording", () => {
    it("stores a record", () => {
      const history = createJobHistory();
      history.record(entry());
      expect(history.get(jobId)?.outcome).toBe("contacted");
    });

    it("preserves firstSeenAt across updates", () => {
      const history = createJobHistory();
      history.record(entry({ now: NOW, outcome: "skipped" }));
      history.record(entry({ now: NOW + 5_000, outcome: "contacted" }));
      const record = history.get(jobId);
      expect(record?.firstSeenAt).toBe(NOW);
      expect(record?.lastProcessedAt).toBe(NOW + 5_000);
    });

    it("records the score and reason when supplied", () => {
      const history = createJobHistory();
      history.record(entry({ score: 84, reason: "+20 Rust" }));
      expect(history.get(jobId)?.score).toBe(84);
      expect(history.get(jobId)?.reason).toBe("+20 Rust");
    });
  });

  describe("duplicate-contact prevention", () => {
    it("blocks a contacted job", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "contacted" }));
      expect(history.blockedJobIds().has(jobId)).toBe(true);
    });

    it("blocks an uncertain job, because a message may have been sent", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "uncertain" }));
      expect(history.blockedJobIds().has(jobId)).toBe(true);
      expect(blocksFurtherContact("uncertain")).toBe(true);
    });

    it("does not block a skipped or rejected job", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "skipped" }));
      history.record(entry({ jobId: asJobId("job-2"), outcome: "rejected" }));
      expect(history.blockedJobIds().size).toBe(0);
    });

    it("does not block a failed job, which is safely retryable", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "failed" }));
      expect(history.blockedJobIds().has(jobId)).toBe(false);
    });
  });

  describe("querying", () => {
    const seeded = () => {
      const history = createJobHistory();
      history.record(entry({ now: NOW, outcome: "contacted" }));
      history.record(
        entry({ jobId: asJobId("j2"), title: "Rust Developer", company: "Rust Co", now: NOW + 1 }),
      );
      history.record(
        entry({
          jobId: asJobId("j3"),
          title: "Sales Lead",
          company: "Sales Co",
          outcome: "skipped",
          now: NOW + 2,
        }),
      );
      return history;
    };

    it("searches by title", () => {
      expect(seeded().query({ text: "rust" })).toHaveLength(1);
    });

    it("searches by company", () => {
      expect(seeded().query({ text: "sales co" })).toHaveLength(1);
    });

    it("is case-insensitive", () => {
      expect(seeded().query({ text: "SALES" })).toHaveLength(1);
    });

    it("filters by outcome", () => {
      expect(seeded().query({ outcomes: ["skipped"] })).toHaveLength(1);
    });

    it("filters by time", () => {
      expect(seeded().query({ since: NOW + 1 })).toHaveLength(2);
    });

    it("limits results", () => {
      expect(seeded().query({ limit: 2 })).toHaveLength(2);
    });

    it("returns results newest first", () => {
      expect(seeded().query()[0]?.jobId).toBe("j3");
    });

    it("returns everything when no query is given", () => {
      expect(seeded().query()).toHaveLength(3);
    });
  });

  describe("counts", () => {
    it("counts by outcome", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "contacted" }));
      history.record(entry({ jobId: asJobId("j2"), outcome: "contacted" }));
      history.record(entry({ jobId: asJobId("j3"), outcome: "skipped" }));
      const counts = history.counts();
      expect(counts.contacted).toBe(2);
      expect(counts.skipped).toBe(1);
      expect(counts.failed).toBe(0);
    });
  });

  describe("clearing", () => {
    it("clears everything on explicit reset", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "contacted" }));
      history.clear();
      expect(history.all()).toHaveLength(0);
    });

    it("keeps blocking records when clearing housekeeping", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "contacted" }));
      history.record(entry({ jobId: asJobId("j2"), outcome: "skipped" }));
      history.record(entry({ jobId: asJobId("j3"), outcome: "uncertain" }));

      const removed = history.clearNonBlocking();
      expect(removed).toBe(1);
      // The contacted and uncertain records must survive: forgetting either
      // could allow a duplicate message or hide one the user must check.
      expect(history.all()).toHaveLength(2);
      expect(history.get(jobId)?.outcome).toBe("contacted");
      expect(history.get(asJobId("j3"))?.outcome).toBe("uncertain");
    });
  });

  describe("daily counting", () => {
    it("counts contacts since a boundary, including uncertain", () => {
      const records = [
        {
          jobId: asJobId("a"),
          platform,
          title: "t",
          company: "c",
          outcome: "contacted" as const,
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
        {
          jobId: asJobId("b"),
          platform,
          title: "t",
          company: "c",
          outcome: "uncertain" as const,
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
        {
          jobId: asJobId("d"),
          platform,
          title: "t",
          company: "c",
          outcome: "skipped" as const,
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
      ];
      // Uncertain counts toward the daily cap: a message may have gone out.
      expect(contactedSince(records, NOW - 1)).toBe(2);
      expect(contactedSince(records, NOW + 1)).toBe(0);
    });
  });

  describe("deserialization of untrusted input", () => {
    it("returns nothing for non-array input", () => {
      expect(deserializeJobHistory(null).records).toEqual([]);
      expect(deserializeJobHistory({}).records).toEqual([]);
    });

    it("drops malformed records and reports the count", () => {
      const result = deserializeJobHistory([
        {
          jobId: "a",
          platform: "boss",
          title: "t",
          company: "c",
          outcome: "contacted",
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
        { jobId: "b" },
        {
          jobId: "c",
          platform: "boss",
          outcome: "nonsense",
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
        null,
      ]);
      expect(result.records).toHaveLength(1);
      expect(result.dropped).toBe(3);
    });

    it("drops a record with an unknown outcome rather than guessing", () => {
      const result = deserializeJobHistory([
        {
          jobId: "a",
          platform: "boss",
          outcome: "teleported",
          firstSeenAt: NOW,
          lastProcessedAt: NOW,
        },
      ]);
      expect(result.records).toHaveLength(0);
      expect(result.dropped).toBe(1);
    });

    it("round-trips through serialize", () => {
      const history = createJobHistory();
      history.record(entry({ score: 84, reason: "why", outcome: "contacted" }));
      const result = deserializeJobHistory(history.serialize());
      expect(result.dropped).toBe(0);
      expect(result.records[0]?.score).toBe(84);
      expect(result.records[0]?.reason).toBe("why");
    });

    it("preserves a contacted record through a simulated reload so it stays blocked", () => {
      const history = createJobHistory();
      history.record(entry({ outcome: "contacted" }));
      const restored = createJobHistory(deserializeJobHistory(history.serialize()).records);
      expect(restored.blockedJobIds().has(jobId)).toBe(true);
    });
  });
});
