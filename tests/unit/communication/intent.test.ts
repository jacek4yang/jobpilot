import { describe, expect, it } from "vitest";
import {
  type CommunicationIntent,
  canClickSend,
  createIntent,
  deserializeIntent,
  type IntentEvent,
  isTerminalPhase,
  reduceIntent,
  SAFE_TO_ABANDON,
  serializeIntent,
} from "../../../src/domain/communication/intent";
import { asJobId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;
const TTL = 180_000;
const MESSAGE = "您好，我对这个职位很感兴趣。";

const intent = (overrides: Partial<Parameters<typeof createIntent>[0]> = {}): CommunicationIntent =>
  createIntent({
    id: "intent-1",
    jobId: asJobId("job-1"),
    sourceUrl: "https://www.zhipin.com/web/geek/job",
    messageText: MESSAGE,
    outgoingBaseline: 0,
    now: NOW,
    ttlMs: TTL,
    ...overrides,
  });

/** Runs a sequence of events, returning the final intent. */
const run = (
  start: CommunicationIntent,
  events: readonly IntentEvent[],
  now = NOW,
): CommunicationIntent => {
  let current = start;
  for (const event of events) {
    current = reduceIntent(current, event, { now }).intent;
  }
  return current;
};

/** Drives an intent all the way to `prepared`. */
const prepared = (): CommunicationIntent =>
  run(intent(), [{ type: "NAVIGATED" }, { type: "CHAT_VERIFIED" }, { type: "MESSAGE_PREPARED" }]);

/** Drives an intent to `send-attempted`. */
const sendAttempted = (): CommunicationIntent =>
  run(prepared(), [{ type: "SEND_DISPATCHED", now: NOW }]);

describe("communication intent", () => {
  describe("creation", () => {
    it("starts armed", () => {
      expect(intent().phase).toBe("armed");
    });

    it("records the outgoing baseline so post-crash verification is possible", () => {
      const created = intent({ outgoingBaseline: 3 });
      expect(created.outgoingBaseline).toBe(3);
    });

    it("sets an expiry from the ttl", () => {
      expect(intent().expiresAt).toBe(NOW + TTL);
    });

    it("does not permit sending before preparation", () => {
      expect(canClickSend(intent())).toBe(false);
    });
  });

  describe("happy path", () => {
    it("advances through the documented phases", () => {
      expect(run(intent(), [{ type: "NAVIGATED" }]).phase).toBe("navigating");
      expect(run(intent(), [{ type: "NAVIGATED" }, { type: "CHAT_VERIFIED" }]).phase).toBe(
        "chat-verified",
      );
      expect(prepared().phase).toBe("prepared");
      expect(sendAttempted().phase).toBe("send-attempted");
    });

    it("permits sending only from prepared", () => {
      expect(canClickSend(prepared())).toBe(true);
      expect(canClickSend(sendAttempted())).toBe(false);
    });

    it("reaches verified when the outgoing count increases", () => {
      const result = reduceIntent(
        sendAttempted(),
        { type: "SEND_OBSERVED", outgoingCount: 1 },
        {
          now: NOW,
        },
      );
      expect(result.intent.phase).toBe("verified");
      expect(result.requiresUserAction).toBe(false);
    });

    it("records when the send was dispatched", () => {
      expect(sendAttempted().sendAttemptedAt).toBe(NOW);
    });
  });

  describe("the never-send-twice invariant", () => {
    it("refuses a second send dispatch after the first", () => {
      const once = sendAttempted();
      const twice = reduceIntent(once, { type: "SEND_DISPATCHED", now: NOW + 1 }, { now: NOW + 1 });
      expect(twice.intent.phase).toBe("send-attempted");
      expect(twice.intent.sendAttemptedAt).toBe(NOW);
      expect(twice.intent).toEqual(once);
    });

    it("refuses a send dispatch from every pre-prepared phase", () => {
      for (const phase of ["armed", "navigating", "chat-verified"] as const) {
        const current = run(intent(), [{ type: "NAVIGATED" }, { type: "CHAT_VERIFIED" }]);
        const forced = { ...current, phase };
        const result = reduceIntent(forced, { type: "SEND_DISPATCHED", now: NOW }, { now: NOW });
        expect(result.intent.phase).toBe(phase);
        expect(result.intent.sendAttemptedAt).toBeUndefined();
      }
    });

    it("ignores every event after a terminal phase", () => {
      const verified = reduceIntent(
        sendAttempted(),
        { type: "SEND_OBSERVED", outgoingCount: 1 },
        {
          now: NOW,
        },
      ).intent;
      const events: readonly IntentEvent[] = [
        { type: "NAVIGATED" },
        { type: "CHAT_VERIFIED" },
        { type: "MESSAGE_PREPARED" },
        { type: "SEND_DISPATCHED", now: NOW + 1 },
      ];
      for (const event of events) {
        expect(reduceIntent(verified, event, { now: NOW + 1 }).intent).toEqual(verified);
      }
    });

    it("never auto-retries after an unobservable send", () => {
      const result = reduceIntent(
        sendAttempted(),
        { type: "SEND_UNOBSERVED", detail: "timeout" },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("uncertain");
      expect(result.requiresUserAction).toBe(true);
      // And a further dispatch attempt still does nothing.
      const retry = reduceIntent(
        result.intent,
        { type: "SEND_DISPATCHED", now: NOW + 1 },
        {
          now: NOW + 1,
        },
      );
      expect(retry.intent.phase).toBe("uncertain");
    });
  });

  describe("unobservable outcomes", () => {
    it("treats a zero-delta observation as uncertain, not failed", () => {
      const result = reduceIntent(
        sendAttempted(),
        { type: "SEND_OBSERVED", outgoingCount: 0 },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("uncertain");
      expect(result.intent.failure).toBe("SEND_UNCERTAIN");
      expect(result.requiresUserAction).toBe(true);
    });

    it("accepts an unchanged count as unverified even with a non-zero baseline", () => {
      const started = run(intent({ outgoingBaseline: 2 }), [
        { type: "NAVIGATED" },
        { type: "CHAT_VERIFIED" },
        { type: "MESSAGE_PREPARED" },
        { type: "SEND_DISPATCHED", now: NOW },
      ]);
      const result = reduceIntent(
        started,
        { type: "SEND_OBSERVED", outgoingCount: 2 },
        {
          now: NOW,
        },
      );
      expect(result.intent.phase).toBe("uncertain");
    });

    it("verifies when the count exceeds a non-zero baseline", () => {
      const started = run(intent({ outgoingBaseline: 2 }), [
        { type: "NAVIGATED" },
        { type: "CHAT_VERIFIED" },
        { type: "MESSAGE_PREPARED" },
        { type: "SEND_DISPATCHED", now: NOW },
      ]);
      const result = reduceIntent(
        started,
        { type: "SEND_OBSERVED", outgoingCount: 3 },
        {
          now: NOW,
        },
      );
      expect(result.intent.phase).toBe("verified");
    });
  });

  describe("draft protection", () => {
    it("fails the transaction when a draft is found before sending", () => {
      const navigating = run(intent(), [{ type: "NAVIGATED" }]);
      const result = reduceIntent(
        navigating,
        { type: "DRAFT_DETECTED", detail: "editor contained user text" },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("failed");
      expect(result.intent.failure).toBe("DRAFT_PRESENT");
      expect(result.requiresUserAction).toBe(true);
    });

    it("refuses to send after a draft was detected", () => {
      const failed = reduceIntent(
        run(intent(), [{ type: "NAVIGATED" }]),
        { type: "DRAFT_DETECTED", detail: "draft" },
        { now: NOW },
      ).intent;
      expect(canClickSend(failed)).toBe(false);
    });
  });

  describe("chat identity changes", () => {
    it("fails safely when the chat changes before a send", () => {
      const preparedIntent = prepared();
      const result = reduceIntent(
        preparedIntent,
        { type: "CHAT_CHANGED", detail: "header changed" },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("failed");
      expect(result.intent.failure).toBe("CHAT_MISMATCH");
    });

    it("marks a post-send chat change as uncertain rather than failed", () => {
      const result = reduceIntent(
        sendAttempted(),
        { type: "CHAT_CHANGED", detail: "user switched conversation" },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("uncertain");
      expect(result.requiresUserAction).toBe(true);
    });
  });

  describe("expiry", () => {
    it("abandons safely when it expires before sending", () => {
      const result = reduceIntent(intent(), { type: "EXPIRED" }, { now: NOW + TTL + 1 });
      expect(result.intent.phase).toBe("failed");
      expect(result.requiresUserAction).toBe(false);
    });

    it("becomes uncertain when it expires after a send attempt", () => {
      const result = reduceIntent(sendAttempted(), { type: "EXPIRED" }, { now: NOW + TTL + 1 });
      expect(result.intent.phase).toBe("uncertain");
      expect(result.intent.failure).toBe("SEND_UNCERTAIN");
      expect(result.requiresUserAction).toBe(true);
    });

    it("ignores expiry before the deadline", () => {
      const result = reduceIntent(intent(), { type: "EXPIRED" }, { now: NOW + 1 });
      expect(result.intent.phase).toBe("armed");
    });
  });

  describe("abort paths", () => {
    it("records the failure code from an abort", () => {
      const result = reduceIntent(
        intent(),
        { type: "ABORTED", failure: "RISK_CONTROL", detail: "verification page" },
        { now: NOW },
      );
      expect(result.intent.phase).toBe("failed");
      expect(result.intent.failure).toBe("RISK_CONTROL");
      expect(result.requiresUserAction).toBe(true);
    });
  });

  describe("phase classification", () => {
    it("knows which phases are safely abandonable", () => {
      for (const phase of SAFE_TO_ABANDON) {
        expect(isTerminalPhase(phase)).toBe(false);
      }
      // send-attempted is NOT safely abandonable: it is reversible only by
      // observation, which is what makes it the point of no return.
      expect(SAFE_TO_ABANDON).not.toContain("send-attempted");
    });

    it("treats verified, uncertain and failed as terminal", () => {
      expect(isTerminalPhase("verified")).toBe(true);
      expect(isTerminalPhase("uncertain")).toBe(true);
      expect(isTerminalPhase("failed")).toBe(true);
    });
  });

  describe("persistence", () => {
    it("round-trips a send-attempted intent", () => {
      const original = sendAttempted();
      const restored = deserializeIntent(serializeIntent(original));
      expect(restored).toEqual(original);
      // The critical property: after a reload the transaction is still not
      // sendable, so recovery can only verify.
      expect(restored === undefined ? false : canClickSend(restored)).toBe(false);
    });

    it("round-trips every optional field", () => {
      const full = createIntent({
        id: "i",
        jobId: asJobId("j"),
        sourceUrl: "https://www.zhipin.com/x",
        messageText: "hi",
        outgoingBaseline: 1,
        now: NOW,
        ttlMs: TTL,
        expectedJobTitle: "Backend Engineer",
        expectedCompany: "Example Corp",
        expectedRecruiter: "Alice",
      });
      const restored = deserializeIntent(serializeIntent(full));
      expect(restored?.expectedJobTitle).toBe("Backend Engineer");
      expect(restored?.expectedCompany).toBe("Example Corp");
      expect(restored?.expectedRecruiter).toBe("Alice");
    });

    it("rejects malformed input rather than guessing", () => {
      expect(deserializeIntent(null)).toBeUndefined();
      expect(deserializeIntent("nope")).toBeUndefined();
      expect(deserializeIntent({})).toBeUndefined();
      expect(deserializeIntent({ id: "a" })).toBeUndefined();
    });

    it("rejects an unknown phase", () => {
      const valid = serializeIntent(intent());
      expect(deserializeIntent({ ...valid, phase: "teleporting" })).toBeUndefined();
    });

    it("rejects a non-numeric baseline", () => {
      const valid = serializeIntent(intent());
      expect(deserializeIntent({ ...valid, outgoingBaseline: "many" })).toBeUndefined();
    });
  });
});
