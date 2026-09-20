import { describe, expect, it } from "vitest";
import { analyzeEvents } from "../../../scripts/diagnostics/analyze";
import type { DiagnosticEvent } from "../../../src/diagnostics/event";
import { EVENTS } from "../../../src/diagnostics/event";

const event = (
  sequence: number,
  name: string,
  transactionId?: string,
  data?: Record<string, string | number | boolean>,
): DiagnosticEvent => ({
  sequence,
  sessionId: "s-test",
  wallTime: 1_700_000_000_000 + sequence,
  monotonicTime: sequence,
  level: "info",
  category: "communication",
  event: name,
  ...(transactionId === undefined ? {} : { transactionId }),
  ...(data === undefined ? {} : { data }),
});

const find = (events: readonly DiagnosticEvent[], prefix: string) =>
  analyzeEvents(events).findings.find((entry) => entry.id.startsWith(prefix));

/**
 * These guard against the analyzer asserting a per-transaction claim from
 * stream-wide evidence.
 *
 * Regression: `transaction.multiple-attempts` and `transaction.mixed-outcome`
 * were computed over flat lists, so two attempts in two DIFFERENT transactions
 * were reported as a `confirmed` duplicate-send violation. That is precisely
 * the invented diagnosis the brief forbids, and it would send a maintainer
 * hunting for a double send that never happened.
 */
describe("analyzer transaction correlation", () => {
  describe("multiple attempts", () => {
    it("does not flag one attempt in each of two transactions", () => {
      const findings = analyzeEvents([
        event(1, EVENTS.sendAttempted, "txn-1"),
        event(2, EVENTS.sendAttempted, "txn-2"),
      ]).findings;
      expect(findings.some((entry) => entry.id.startsWith("transaction.multiple-attempts"))).toBe(
        false,
      );
    });

    it("flags two attempts within one transaction as confirmed", () => {
      const finding = find(
        [event(1, EVENTS.sendAttempted, "txn-1"), event(2, EVENTS.sendAttempted, "txn-1")],
        "transaction.multiple-attempts",
      );
      expect(finding?.confidence).toBe("confirmed");
      expect(finding?.detail).toContain("txn-1");
    });

    it("reports unknown when the events carry no transaction id", () => {
      // Without an id we cannot tell whether these are one transaction or two,
      // so neither "confirmed" nor "likely" is honest — only "unknown".
      const finding = find(
        [event(1, EVENTS.sendAttempted), event(2, EVENTS.sendAttempted)],
        "transaction.multiple-attempts",
      );
      expect(finding?.confidence).toBe("unknown");
    });

    it("does not flag a single attempt", () => {
      expect(
        find([event(1, EVENTS.sendAttempted, "txn-1")], "transaction.multiple-attempts"),
      ).toBeUndefined();
    });
  });

  describe("mixed terminal outcomes", () => {
    it("does not flag a commit in one transaction and an uncertainty in another", () => {
      const findings = analyzeEvents([
        event(1, EVENTS.transactionCommitted, "txn-1"),
        event(2, EVENTS.transactionUncertain, "txn-2"),
      ]).findings;
      expect(findings.some((entry) => entry.id.startsWith("transaction.mixed-outcome"))).toBe(
        false,
      );
    });

    it("flags one transaction reaching two terminal states as confirmed", () => {
      const finding = find(
        [
          event(1, EVENTS.transactionCommitted, "txn-1"),
          event(2, EVENTS.transactionUncertain, "txn-1"),
        ],
        "transaction.mixed-outcome",
      );
      expect(finding?.confidence).toBe("confirmed");
    });

    it("flags a commit and a failure in the same transaction", () => {
      const finding = find(
        [
          event(1, EVENTS.transactionCommitted, "txn-9"),
          event(2, EVENTS.transactionFailed, "txn-9"),
        ],
        "transaction.mixed-outcome",
      );
      expect(finding?.confidence).toBe("confirmed");
    });

    it("does not flag a single terminal outcome", () => {
      expect(
        find([event(1, EVENTS.transactionCommitted, "txn-1")], "transaction.mixed-outcome"),
      ).toBeUndefined();
    });
  });

  describe("ordering claims remain stream-wide by nature", () => {
    it("flags a click with no preceding attempt", () => {
      const finding = find(
        [event(1, EVENTS.sendClicked, "txn-1")],
        "transaction.click-without-intent",
      );
      expect(finding?.confidence).toBe("confirmed");
    });

    it("does not flag a click preceded by an attempt", () => {
      const finding = find(
        [event(1, EVENTS.sendAttempted, "txn-1"), event(2, EVENTS.sendClicked, "txn-1")],
        "transaction.click-without-intent",
      );
      expect(finding).toBeUndefined();
    });

    it("flags verification with no preceding attempt", () => {
      const finding = find(
        [event(1, EVENTS.verificationStarted, "txn-1")],
        "transaction.verify-without-attempt",
      );
      expect(finding?.confidence).toBe("confirmed");
    });
  });

  describe("every finding carries evidence", () => {
    it("cites at least one sequence for a detected violation", () => {
      const findings = analyzeEvents([
        event(1, EVENTS.sendAttempted, "txn-1"),
        event(2, EVENTS.sendAttempted, "txn-1"),
        event(3, EVENTS.sendClicked, "txn-1"),
      ]).findings;

      const violations = findings.filter(
        (entry) => entry.confidence === "confirmed" && entry.id !== "selector.clean",
      );
      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations) {
        // A confirmed finding the reader cannot check is not evidence-based.
        expect(violation.evidence.length).toBeGreaterThan(0);
      }
    });
  });
});

/**
 * Guards against a detector asserting more than it checked.
 *
 * Three separate defects lived here: the storage finding claimed a send was
 * refused without looking, the queue detector reported a legitimate
 * restore-after-reload as a confirmed duplicate, and claims resting on absent
 * evidence were labelled `likely` rather than `unknown`.
 */
describe("analyzer claims match their evidence", () => {
  const ev = (
    sequence: number,
    name: string,
    category: string,
    transactionId?: string,
  ): DiagnosticEvent => ({
    sequence,
    sessionId: "s-test",
    wallTime: 0,
    monotonicTime: sequence,
    level: "info",
    category: category as DiagnosticEvent["category"],
    event: name,
    ...(transactionId === undefined ? {} : { transactionId }),
  });

  describe("storage failure", () => {
    it("does not claim a send was refused without checking", () => {
      const finding = analyzeEvents([ev(1, EVENTS.storageWriteFailed, "storage")]).findings.find(
        (entry) => entry.id === "health.storage",
      );
      // The old text asserted read-only enforcement and then told the reader to
      // go and verify it, which is the check the claim presumed.
      expect(finding?.detail).not.toContain("should have entered read-only");
      expect(finding?.detail).toContain("No send event follows");
    });

    it("flags the dangerous combination when a send does follow", () => {
      const finding = analyzeEvents([
        ev(1, EVENTS.storageWriteFailed, "storage"),
        ev(2, EVENTS.sendClicked, "communication", "txn-1"),
      ]).findings.find((entry) => entry.id === "health.storage");
      expect(finding?.confidence).toBe("confirmed");
      expect(finding?.title).toContain("send followed");
    });

    it("ignores a send that happened before the failure", () => {
      const finding = analyzeEvents([
        ev(1, EVENTS.sendClicked, "communication", "txn-1"),
        ev(2, EVENTS.storageWriteFailed, "storage"),
      ]).findings.find((entry) => entry.id === "health.storage");
      // Ordering matters: an earlier send is not evidence the gate failed.
      expect(finding?.detail).toContain("No send event follows");
    });
  });

  describe("queue duplicates", () => {
    const started = (sequence: number) => ({
      ...ev(sequence, EVENTS.queueItemStarted, "queue"),
      queueItemId: "j1",
    });

    it("reports a settled-then-restarted item as confirmed", () => {
      const completed = { ...ev(2, EVENTS.queueItemCompleted, "queue"), queueItemId: "j1" };
      const finding = analyzeEvents([started(1), completed, started(3)]).findings.find((entry) =>
        entry.id.startsWith("queue.duplicate-processing"),
      );
      expect(finding?.confidence).toBe("confirmed");
      expect(finding?.title).toContain("settled");
    });

    it("downgrades a restart without a settling event to likely", () => {
      // A restore after a reload legitimately re-starts an interrupted item.
      const finding = analyzeEvents([started(1), started(2)]).findings.find((entry) =>
        entry.id.startsWith("queue.duplicate-processing"),
      );
      expect(finding?.confidence).toBe("likely");
      expect(finding?.detail).toContain("restore");
    });

    it("does not flag a single start", () => {
      const finding = analyzeEvents([started(1)]).findings.find((entry) =>
        entry.id.startsWith("queue.duplicate-processing"),
      );
      expect(finding).toBeUndefined();
    });
  });

  describe("coverage gaps are stated explicitly", () => {
    it("reports unknown rather than likely when the id is absent", () => {
      const finding = analyzeEvents([
        ev(1, EVENTS.sendAttempted, "communication"),
        ev(2, EVENTS.sendAttempted, "communication"),
      ]).findings.find((entry) => entry.id.startsWith("transaction.multiple-attempts"));
      // "likely" would assert a consistency we have not established.
      expect(finding?.confidence).toBe("unknown");
    });

    it("emits a coverage finding when communication events lack an id", () => {
      const finding = analyzeEvents([ev(1, EVENTS.sendAttempted, "communication")]).findings.find(
        (entry) => entry.id === "transaction.coverage-gap",
      );
      expect(finding).toBeDefined();
      expect(finding?.nextStep).toContain("transactionId");
    });

    it("does not emit a coverage finding when every event carries an id", () => {
      const finding = analyzeEvents([
        ev(1, EVENTS.sendAttempted, "communication", "txn-1"),
        ev(2, EVENTS.sendClicked, "communication", "txn-1"),
      ]).findings.find((entry) => entry.id === "transaction.coverage-gap");
      expect(finding).toBeUndefined();
    });

    it("does not emit a coverage finding for a bundle with no communication at all", () => {
      const finding = analyzeEvents([ev(1, EVENTS.routeChanged, "route")]).findings.find(
        (entry) => entry.id === "transaction.coverage-gap",
      );
      expect(finding).toBeUndefined();
    });
  });
});
