import { describe, expect, it, vi } from "vitest";
import type { CommunicationAction } from "../../../src/adapters/boss/communication";
import { createCommunicationRunner } from "../../../src/application/communication-runner";
import type { ChatIdentity } from "../../../src/domain/communication/identity";
import type { CommunicationIntent } from "../../../src/domain/communication/intent";
import { createIntent } from "../../../src/domain/communication/intent";
import { asJobId } from "../../../src/domain/support/ids";
import type { Clock } from "../../../src/domain/support/shared";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";
import type { BlockReason } from "../../../src/ports/job-platform";

const TTL = 180_000;
const MESSAGE = "您好，我对该职位很感兴趣。";

/** Clock the test advances explicitly, so the observe loop terminates deterministically. */
const makeClock = (start = 1_700_000_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  } satisfies Clock & { advance: (ms: number) => void };
};

const intent = (overrides: Partial<Parameters<typeof createIntent>[0]> = {}): CommunicationIntent =>
  createIntent({
    id: "intent-1",
    jobId: asJobId("job-1"),
    sourceUrl: "https://www.zhipin.com/web/geek/job",
    messageText: MESSAGE,
    outgoingBaseline: 0,
    now: 1_700_000_000_000,
    ttlMs: TTL,
    expectedJobTitle: "后端开发工程师",
    expectedCompany: "示例科技有限公司",
    ...overrides,
  });

const matchingChat: ChatIdentity = {
  jobIds: [],
  text: "后端开发工程师 示例科技有限公司 李女士",
};

/** A configurable fake action surface that records every call. */
const makeAction = (options: {
  readonly block?: { readonly reason: BlockReason; readonly evidence: string } | null;
  readonly chat?: ChatIdentity | null;
  readonly prepare?: Awaited<ReturnType<CommunicationAction["prepareMessage"]>>;
  readonly dispatch?: Awaited<ReturnType<CommunicationAction["dispatchSend"]>>;
  /** Values returned by successive observeSend calls, last one repeats. */
  readonly observations?: readonly Awaited<ReturnType<CommunicationAction["observeSend"]>>[];
}) => {
  const calls = {
    dispatch: 0,
    prepare: 0,
    observe: 0,
  };

  let observeIndex = 0;
  const observations = options.observations ?? [
    { kind: "observed" as const, count: 1, evidence: "outgoing bubble present" },
  ];

  const action: CommunicationAction = {
    findCommunicateButton: () => null,
    readCurrentChat: () => (options.chat === undefined ? matchingChat : options.chat),
    readEditor: () => null,
    outgoingCount: () => 0,
    prepareMessage: async () => {
      calls.prepare += 1;
      return options.prepare ?? { kind: "ready", text: MESSAGE };
    },
    dispatchSend: async () => {
      calls.dispatch += 1;
      return options.dispatch ?? { kind: "dispatched" };
    },
    observeSend: async () => {
      calls.observe += 1;
      const value = observations[Math.min(observeIndex, observations.length - 1)];
      observeIndex += 1;
      return value ?? { kind: "unobserved", detail: "no observation configured" };
    },
    classifyModal: () => ({ kind: "none" }),
    detectBlock: () => options.block ?? null,
  };

  return { action, calls };
};

const runner = (
  action: CommunicationAction,
  clock: Clock,
  overrides: Partial<Parameters<typeof createCommunicationRunner>[0]> = {},
) =>
  createCommunicationRunner({
    action,
    logger: createNullLogger(),
    clock,
    persistIntent: async () => {},
    clearIntent: async () => {},
    ...overrides,
  });

describe("communication runner", () => {
  describe("the happy path", () => {
    it("reports sent only after observing an outgoing message", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({});
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("sent");
      expect(calls.dispatch).toBe(1);
    });

    it("persists send-attempted before the click and verified after it", async () => {
      const clock = makeClock();
      const phases: string[] = [];
      // Record the phase trail, and the moment the adapter is asked to click.
      let dispatchOrder = -1;
      const { action } = makeAction({});
      const wrapped: CommunicationAction = {
        ...action,
        dispatchSend: async (value, opts) => {
          dispatchOrder = phases.length;
          return action.dispatchSend(value, opts);
        },
      };

      await runner(wrapped, clock, {
        persistIntent: async (value) => {
          phases.push(value.phase);
        },
      }).run(intent());

      const attemptedIndex = phases.indexOf("send-attempted");
      expect(attemptedIndex).toBeGreaterThanOrEqual(0);
      expect(phases).toContain("verified");

      // The decisive ordering property: `send-attempted` is persisted BEFORE
      // the click is dispatched, so a crash between the two cannot cause a
      // second send — recovery sees send-attempted and may only verify.
      expect(attemptedIndex).toBeLessThan(dispatchOrder);
    });

    it("clears the intent once it reaches a terminal phase", async () => {
      const clock = makeClock();
      const { action } = makeAction({});
      const clearIntent = vi.fn(async () => {});
      await runner(action, clock, { clearIntent }).run(intent());
      expect(clearIntent).toHaveBeenCalledTimes(1);
    });
  });

  describe("never sends twice", () => {
    it("calls dispatchSend exactly once per run", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({});
      await runner(action, clock).run(intent());
      expect(calls.dispatch).toBe(1);
    });

    it("does not click send when the conversation cannot be confirmed", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({
        chat: { jobIds: [], text: "some other job at another company" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("aborted");
      expect(calls.dispatch).toBe(0);
      expect(calls.prepare).toBe(0);
    });

    it("treats an unconfirmed identity as unsafe rather than writing anyway", async () => {
      const clock = makeClock();
      // Title matches but nothing corroborates it: `insufficient`, not `match`.
      const { action, calls } = makeAction({
        chat: { jobIds: [], text: "后端开发工程师" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("aborted");
      if (outcome.kind === "aborted") expect(outcome.failure).toBe("CHAT_MISMATCH");
      expect(calls.dispatch).toBe(0);
    });

    it("does not click send when a draft is present", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({
        prepare: { kind: "draft-present", text: "user typed this" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("aborted");
      if (outcome.kind === "aborted") expect(outcome.failure).toBe("DRAFT_PRESENT");
      expect(calls.dispatch).toBe(0);
    });
  });

  describe("uncertainty is never rounded to success", () => {
    it("reports uncertain when no outgoing message is observed", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({
        observations: [{ kind: "unobserved", detail: "no bubble" }],
      });

      // Drive the fake clock forward so the observe loop reaches its deadline.
      const advancing = setInterval(() => clock.advance(1_000), 1);
      const outcome = await runner(action, clock, {}).run(intent(), {
        observeTimeoutMs: 100,
        observeIntervalMs: 1,
      });
      clearInterval(advancing);

      expect(outcome.kind).toBe("uncertain");
      // The click did happen once; it is simply unverifiable.
      expect(calls.dispatch).toBe(1);
    });

    it("reports uncertain when the adapter refuses the send", async () => {
      const clock = makeClock();
      const { action } = makeAction({
        dispatch: { kind: "refused", detail: "transaction is not sendable" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("uncertain");
    });

    it("does not report sent when observation only repeats the baseline count", async () => {
      const clock = makeClock();
      const { action } = makeAction({
        observations: [{ kind: "unobserved", detail: "count unchanged at baseline" }],
      });

      const advancing = setInterval(() => clock.advance(1_000), 1);
      const outcome = await runner(action, clock).run(intent({ outgoingBaseline: 2 }), {
        observeTimeoutMs: 100,
        observeIntervalMs: 1,
      });
      clearInterval(advancing);

      expect(outcome.kind).toBe("uncertain");
    });
  });

  describe("blocked signals stop everything", () => {
    for (const reason of ["captcha", "risk-control", "login-expired"] as const) {
      it(`stops before writing on ${reason}`, async () => {
        const clock = makeClock();
        const { action, calls } = makeAction({
          block: { reason, evidence: "detected" },
        });
        const outcome = await runner(action, clock).run(intent());
        expect(outcome.kind).toBe("blocked");
        if (outcome.kind === "blocked") expect(outcome.reason).toBe(reason);
        // Nothing was read, written or clicked.
        expect(calls.dispatch).toBe(0);
        expect(calls.prepare).toBe(0);
      });
    }

    it("reports blocked when preparation hits a block", async () => {
      const clock = makeClock();
      const { action, calls } = makeAction({
        prepare: { kind: "blocked", reason: "risk-control", evidence: "mid-flow" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("blocked");
      expect(calls.dispatch).toBe(0);
    });

    it("reports blocked when dispatch hits a block", async () => {
      const clock = makeClock();
      const { action } = makeAction({
        dispatch: { kind: "blocked", reason: "captcha", evidence: "appeared" },
      });
      const outcome = await runner(action, clock).run(intent());
      expect(outcome.kind).toBe("blocked");
    });
  });

  describe("abort handling", () => {
    it("reports uncertain if aborted while awaiting confirmation", async () => {
      const clock = makeClock();
      const controller = new AbortController();
      const { action, calls } = makeAction({
        observations: [{ kind: "unobserved", detail: "not yet" }],
      });

      const advancing = setInterval(() => clock.advance(1_000), 1);
      controller.abort();
      const outcome = await runner(action, clock).run(intent(), {
        observeTimeoutMs: 100_000,
        observeIntervalMs: 1,
        signal: controller.signal,
      });
      clearInterval(advancing);

      expect(outcome.kind).toBe("uncertain");
      // Already dispatched, so uncertainty is the only honest answer.
      expect(calls.dispatch).toBe(1);
    });
  });

  describe("observability", () => {
    it("logs a warning when the outcome is unconfirmed", async () => {
      const clock = makeClock();
      const warn = vi.fn();
      const logger = { ...createNullLogger(), warn };
      const { action } = makeAction({
        observations: [{ kind: "unobserved", detail: "nothing" }],
      });

      const advancing = setInterval(() => clock.advance(1_000), 1);
      await runner(action, clock, { logger }).run(intent(), {
        observeTimeoutMs: 100,
        observeIntervalMs: 1,
      });
      clearInterval(advancing);

      expect(warn).toHaveBeenCalled();
    });
  });
});

describe("observe loop termination", () => {
  it("terminates even when the injected clock never advances", async () => {
    // Regression: the loop condition was purely wall-clock based, so a frozen
    // clock made it spin forever dispatching observeSend. That is an unbounded
    // retry loop, which this project must never contain.
    const frozen: Clock = { now: () => 1_700_000_000_000 };
    const { action, calls } = makeAction({
      observations: [{ kind: "unobserved", detail: "never appears" }],
    });

    const outcome = await runner(action, frozen).run(intent(), {
      observeTimeoutMs: 100,
      observeIntervalMs: 10,
    });

    expect(outcome.kind).toBe("uncertain");
    // 100ms / 10ms => at most 10 iterations, plus the initial dispatch.
    expect(calls.observe).toBeLessThanOrEqual(11);
    expect(calls.dispatch).toBe(1);
  });

  it("stops at the first observation that confirms the send", async () => {
    const clock = makeClock();
    const { action, calls } = makeAction({
      observations: [
        { kind: "unobserved", detail: "not yet" },
        { kind: "observed", count: 1, evidence: "bubble appeared" },
        { kind: "observed", count: 2, evidence: "should not be reached" },
      ],
    });

    const outcome = await runner(action, clock).run(intent(), {
      observeTimeoutMs: 1_000,
      observeIntervalMs: 1,
    });

    expect(outcome.kind).toBe("sent");
    // Exactly two polls: the failed one and the confirming one.
    expect(calls.observe).toBe(2);
  });
});
