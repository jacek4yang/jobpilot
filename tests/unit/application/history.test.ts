import { describe, expect, it } from "vitest";
import { createApplicationHistory, deserializeHistory } from "../../../src/application/history";
import {
  applicationIdFor,
  canTransitionTo,
  createApplicationRecord,
  isSubmissionFinal,
} from "../../../src/domain/application/application";
import { asJobId, asPlatformId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;
const platform = asPlatformId("boss");
const jobId = asJobId("job-1");

describe("application history", () => {
  describe("creation", () => {
    it("derives a stable application id from platform and job id", () => {
      const first = applicationIdFor(platform, jobId);
      const second = applicationIdFor(platform, jobId);
      expect(first).toBe(second);
    });

    it("derives different ids for different jobs", () => {
      expect(applicationIdFor(platform, jobId)).not.toBe(
        applicationIdFor(platform, asJobId("job-2")),
      );
    });

    it("starts a record in the discovered state", () => {
      const record = createApplicationRecord({ platform, jobId, now: NOW });
      expect(record.status).toBe("discovered");
      expect(record.attempts).toBe(0);
      expect(record.reasons).toEqual([]);
    });
  });

  describe("deduplication", () => {
    it("does not create a second record for the same job", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.discover(platform, jobId, NOW + 1_000);
      expect(history.all()).toHaveLength(1);
    });

    it("reports a discovered job as present", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      expect(history.has(jobId)).toBe(true);
    });

    it("reports an unknown job as absent", () => {
      const history = createApplicationHistory();
      expect(history.has(jobId)).toBe(false);
    });
  });

  describe("double-submission prevention", () => {
    const submitted = () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW });
      history.transition(jobId, "approved", { now: NOW });
      history.transition(jobId, "opened", { now: NOW });
      history.transition(jobId, "submitted", { now: NOW });
      return history;
    };

    it("lists submitted jobs as permanently locked", () => {
      expect(submitted().submittedJobIds().has(jobId)).toBe(true);
    });

    it("refuses to move a submitted job back to approved", () => {
      const history = submitted();
      const result = history.transition(jobId, "approved", { now: NOW + 1 });
      expect(result?.status).toBe("submitted");
    });

    it("refuses to re-open a submitted job", () => {
      const history = submitted();
      const result = history.transition(jobId, "opened", { now: NOW + 1 });
      expect(result?.status).toBe("submitted");
    });

    it("keeps a verified job locked", () => {
      const history = submitted();
      history.transition(jobId, "verified", { now: NOW });
      expect(history.get(jobId)?.status).toBe("verified");
      expect(history.transition(jobId, "approved", { now: NOW + 1 })?.status).toBe("verified");
    });

    it("locks a job once it is submitted, surviving a simulated reload", () => {
      const before = submitted();
      const reloaded = createApplicationHistory(deserializeHistory(before.serialize()));
      expect(reloaded.submittedJobIds().has(jobId)).toBe(true);
    });
  });

  describe("transition graph", () => {
    it("permits the documented happy path", () => {
      expect(canTransitionTo("discovered", "evaluated")).toBe(true);
      expect(canTransitionTo("evaluated", "approved")).toBe(true);
      expect(canTransitionTo("approved", "opened")).toBe(true);
      expect(canTransitionTo("opened", "submitted")).toBe(true);
      expect(canTransitionTo("submitted", "verified")).toBe(true);
    });

    it("forbids skipping verification straight to verified", () => {
      expect(canTransitionTo("opened", "verified")).toBe(false);
    });

    it("forbids leaving a terminal state", () => {
      expect(canTransitionTo("verified", "approved")).toBe(false);
      expect(canTransitionTo("rejected", "approved")).toBe(false);
    });

    it("treats submitted and verified as final for submission purposes", () => {
      expect(isSubmissionFinal("submitted")).toBe(true);
      expect(isSubmissionFinal("verified")).toBe(true);
      expect(isSubmissionFinal("approved")).toBe(false);
    });

    it("ignores an illegal transition rather than corrupting the record", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW });
      history.transition(jobId, "rejected", { now: NOW });
      const result = history.transition(jobId, "approved", { now: NOW + 1 });
      expect(result?.status).toBe("rejected");
    });

    it("allows re-asserting the current status idempotently", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW });
      const again = history.transition(jobId, "evaluated", { now: NOW + 1 });
      expect(again?.status).toBe("evaluated");
    });

    it("returns undefined when transitioning an unknown job", () => {
      const history = createApplicationHistory();
      expect(history.transition(jobId, "evaluated", { now: NOW })).toBeUndefined();
    });
  });

  describe("recording reasons", () => {
    it("appends reasons rather than replacing them", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW, reasons: ["first"] });
      history.transition(jobId, "approved", { now: NOW, reasons: ["second"] });
      expect(history.get(jobId)?.reasons).toEqual(["first", "second"]);
    });

    it("records the score at evaluation time", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW, score: 72 });
      expect(history.get(jobId)?.score).toBe(72);
    });

    it("counts attempts only when asked", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW });
      expect(history.get(jobId)?.attempts).toBe(0);
      history.transition(jobId, "approved", { now: NOW, incrementAttempts: true });
      expect(history.get(jobId)?.attempts).toBe(1);
    });
  });

  describe("counts", () => {
    it("counts records by status", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.discover(platform, asJobId("job-2"), NOW);
      history.transition(jobId, "evaluated", { now: NOW });
      history.transition(jobId, "approved", { now: NOW });
      const counts = history.counts();
      expect(counts.approved).toBe(1);
      expect(counts.discovered).toBe(1);
      expect(counts.submitted).toBe(0);
    });
  });

  describe("deserialization of untrusted input", () => {
    it("returns an empty list for non-array input", () => {
      expect(deserializeHistory(null)).toEqual([]);
      expect(deserializeHistory("nope")).toEqual([]);
      expect(deserializeHistory(42)).toEqual([]);
      expect(deserializeHistory({})).toEqual([]);
    });

    it("drops records missing required fields", () => {
      const input = [
        { jobId: "a", platform: "boss", status: "approved", createdAt: NOW },
        { jobId: "b", status: "approved" },
        { platform: "boss", status: "approved", createdAt: NOW },
        { jobId: "d", platform: "boss", createdAt: NOW },
        { jobId: "e", platform: "boss", status: "not-a-status", createdAt: NOW },
      ];
      const records = deserializeHistory(input);
      expect(records).toHaveLength(1);
      expect(records[0]?.jobId).toBe("a");
    });

    it("drops malformed entries without throwing", () => {
      expect(() => deserializeHistory([null, undefined, 1, "x", []])).not.toThrow();
      expect(deserializeHistory([null, undefined, 1, "x", []])).toEqual([]);
    });

    it("sanitises field types within an otherwise valid record", () => {
      const records = deserializeHistory([
        {
          jobId: "a",
          platform: "boss",
          status: "approved",
          createdAt: NOW,
          updatedAt: "nonsense",
          attempts: "many",
          reasons: ["ok", 42, null],
          score: "high",
        },
      ]);
      const record = records[0];
      expect(record?.attempts).toBe(0);
      expect(record?.updatedAt).toBe(NOW);
      expect(record?.reasons).toEqual(["ok"]);
      expect(record?.score).toBeUndefined();
    });

    it("round-trips a history through serialize and deserialize", () => {
      const history = createApplicationHistory();
      history.discover(platform, jobId, NOW);
      history.transition(jobId, "evaluated", { now: NOW, score: 55, reasons: ["why"] });
      const restored = deserializeHistory(history.serialize());
      expect(restored).toHaveLength(1);
      expect(restored[0]?.status).toBe("evaluated");
      expect(restored[0]?.score).toBe(55);
      expect(restored[0]?.reasons).toEqual(["why"]);
    });
  });
});
