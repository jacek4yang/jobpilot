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

    it("downgrades to likely when the events carry no transaction id", () => {
      // Without an id the claim cannot be proven, so it must not be asserted.
      const finding = find(
        [event(1, EVENTS.sendAttempted), event(2, EVENTS.sendAttempted)],
        "transaction.multiple-attempts",
      );
      expect(finding?.confidence).toBe("likely");
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
