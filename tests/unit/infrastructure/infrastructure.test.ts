import { describe, expect, it } from "vitest";
import type { Clock } from "../../../src/domain/support/shared";
import { createLogger } from "../../../src/infrastructure/logging/logger";
import {
  evaluateRateLimit,
  evaluateSessionLimits,
  nextDelayMs,
  sleep,
} from "../../../src/infrastructure/rate-limit/rate-limiter";
import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  withRetry,
} from "../../../src/infrastructure/retry/retry";
import { createWatchdog } from "../../../src/infrastructure/watchdog/watchdog";
import { redact } from "../../../src/ports/logger";

const NOW = 1_700_000_000_000;

/** Clock whose value the test controls. */
const fakeClock = (start = NOW): Clock & { advance: (ms: number) => void } => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const fixedRandom = (value: number) => ({ next: () => value });

describe("retry", () => {
  it("returns the value on first success", async () => {
    const result = await withRetry(async () => 42, {
      clock: fakeClock(),
      policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      safety: "idempotent",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("retries an idempotent operation", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      {
        clock: fakeClock(),
        policy: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
        safety: "idempotent",
      },
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("REFUSES to retry an unsafe operation", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        throw new Error("click may have registered");
      },
      {
        clock: fakeClock(),
        policy: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
        safety: "unsafe",
      },
    );
    expect(result.ok).toBe(false);
    // The critical safety property: exactly one attempt, never a blind resubmit.
    expect(attempts).toBe(1);
    if (!result.ok) expect(result.refusedUnsafeRetry).toBe(true);
  });

  it("does not retry when the error is classified non-retryable", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        throw new Error("validation");
      },
      {
        clock: fakeClock(),
        policy: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
        safety: "idempotent",
        isRetryable: () => false,
      },
    );
    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("stops after exhausting maxAttempts", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        throw new Error("always");
      },
      {
        clock: fakeClock(),
        policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        safety: "idempotent",
      },
    );
    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
  });

  it("computes exponential backoff with a ceiling", () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(backoffDelayMs(1, policy)).toBe(100);
    expect(backoffDelayMs(2, policy)).toBe(200);
    expect(backoffDelayMs(3, policy)).toBe(400);
    expect(backoffDelayMs(10, policy)).toBe(1_000);
  });

  it("reports how many attempts were made", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        throw new Error("x");
      },
      {
        clock: fakeClock(),
        policy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        safety: "idempotent",
      },
    );
    if (!result.ok) expect(result.attempts).toBe(2);
    expect(attempts).toBe(2);
  });

  it("keeps the default policy bounded", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(30_000);
  });
});

describe("rate limiting", () => {
  it("allows actions below the hourly cap", () => {
    const clock = fakeClock();
    const decision = evaluateRateLimit([], { clock, maxPerHour: 3 });
    expect(decision.allowed).toBe(true);
  });

  it("blocks once the hourly cap is reached", () => {
    const clock = fakeClock();
    const timestamps = [NOW - 1_000, NOW - 2_000, NOW - 3_000];
    expect(evaluateRateLimit(timestamps, { clock, maxPerHour: 3 }).allowed).toBe(false);
  });

  it("reports when the next action becomes legal", () => {
    const clock = fakeClock();
    const timestamps = [NOW - 1_000, NOW - 2_000, NOW - 3_000];
    const decision = evaluateRateLimit(timestamps, { clock, maxPerHour: 3 });
    // The oldest timestamp in the window frees the next slot when it ages out.
    expect(decision.retryAt).toBe(NOW - 3_000 + 3_600_000);
  });

  it("ignores timestamps outside the window", () => {
    const clock = fakeClock();
    const old = [NOW - 7_200_000, NOW - 7_300_000, NOW - 7_400_000];
    expect(evaluateRateLimit(old, { clock, maxPerHour: 3 }).allowed).toBe(true);
  });

  it("treats a zero cap as unlimited", () => {
    const clock = fakeClock();
    expect(evaluateRateLimit([NOW, NOW, NOW], { clock, maxPerHour: 0 }).allowed).toBe(true);
  });

  it("blocks when the session cap is reached", () => {
    const clock = fakeClock();
    const verdict = evaluateSessionLimits(
      { sessionApplications: 20, applicationTimestamps: [] },
      { maxApplicationsPerSession: 20, maxApplicationsPerHour: 15 },
      { clock, maxPerHour: 15 },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe("session");
  });

  it("blocks when the hourly cap is reached", () => {
    const clock = fakeClock();
    const verdict = evaluateSessionLimits(
      { sessionApplications: 1, applicationTimestamps: [NOW, NOW, NOW] },
      { maxApplicationsPerSession: 20, maxApplicationsPerHour: 3 },
      { clock, maxPerHour: 3 },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe("hourly");
  });

  it("allows when both caps have headroom", () => {
    const clock = fakeClock();
    const verdict = evaluateSessionLimits(
      { sessionApplications: 1, applicationTimestamps: [NOW] },
      { maxApplicationsPerSession: 20, maxApplicationsPerHour: 15 },
      { clock, maxPerHour: 15 },
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe("delay policy", () => {
  it("returns the exact value when min equals max", () => {
    expect(nextDelayMs({ minActionDelayMs: 500, maxActionDelayMs: 500 }, fixedRandom(0.5))).toBe(
      500,
    );
  });

  it("stays within the configured window", () => {
    const policy = { minActionDelayMs: 1_000, maxActionDelayMs: 5_000 };
    expect(nextDelayMs(policy, fixedRandom(0))).toBe(1_000);
    expect(nextDelayMs(policy, fixedRandom(0.999))).toBeLessThanOrEqual(5_000);
    expect(nextDelayMs(policy, fixedRandom(0.5))).toBe(3_000);
  });

  it("tolerates an inverted window without producing a negative delay", () => {
    const policy = { minActionDelayMs: 5_000, maxActionDelayMs: 1_000 };
    expect(nextDelayMs(policy, fixedRandom(0.5))).toBeGreaterThanOrEqual(5_000);
  });
});

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, { signal: controller.signal })).rejects.toThrow();
  });

  it("rejects when aborted mid-sleep", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("watchdog", () => {
  it("does not fire before the budget elapses", () => {
    const clock = fakeClock();
    const stalls: string[] = [];
    const watchdog = createWatchdog({
      clock,
      budgets: [{ state: "applying", timeoutMs: 1_000 }],
      onStall: (state) => stalls.push(state),
    });
    watchdog.watch("applying");
    clock.advance(500);
    watchdog.stop();
    expect(stalls).toHaveLength(0);
  });

  it("reports a stalled state once its budget elapses", async () => {
    const clock = fakeClock();
    const stalls: string[] = [];
    const watchdog = createWatchdog({
      clock,
      budgets: [{ state: "applying", timeoutMs: 10 }],
      onStall: (state) => stalls.push(state),
      intervalMs: 5,
    });
    watchdog.watch("applying");
    watchdog.start();
    clock.advance(100);
    await sleep(40);
    watchdog.stop();
    expect(stalls).toContain("applying");
  });

  it("stops reporting after the per-state ceiling, preventing infinite loops", async () => {
    const clock = fakeClock();
    let count = 0;
    const watchdog = createWatchdog({
      clock,
      budgets: [{ state: "applying", timeoutMs: 1 }],
      onStall: () => {
        count += 1;
      },
      intervalMs: 1,
      maxStallsPerState: 2,
    });
    watchdog.watch("applying");
    watchdog.start();
    clock.advance(1_000);
    await sleep(60);
    watchdog.stop();
    expect(count).toBeLessThanOrEqual(2);
  });

  it("resets the stall counter when the state changes", async () => {
    const clock = fakeClock();
    const stalls: string[] = [];
    const watchdog = createWatchdog({
      clock,
      budgets: [
        { state: "applying", timeoutMs: 1 },
        { state: "verifying", timeoutMs: 1 },
      ],
      onStall: (state) => stalls.push(state),
      intervalMs: 1,
    });
    watchdog.watch("applying");
    watchdog.start();

    // The watchdog samples a fake clock, so time has to be advanced explicitly
    // while the interval callback is given a chance to run.
    clock.advance(100);
    await sleep(20);

    watchdog.watch("verifying");
    clock.advance(100);
    await sleep(20);

    watchdog.stop();
    expect(stalls).toContain("verifying");
  });

  it("is idempotent when stopped twice", () => {
    const watchdog = createWatchdog({
      clock: fakeClock(),
      budgets: [],
      onStall: () => {},
    });
    watchdog.start();
    watchdog.stop();
    expect(() => watchdog.stop()).not.toThrow();
    expect(watchdog.running).toBe(false);
  });

  it("ignores states with no configured budget", async () => {
    const clock = fakeClock();
    let fired = false;
    const watchdog = createWatchdog({
      clock,
      budgets: [{ state: "applying", timeoutMs: 1 }],
      onStall: () => {
        fired = true;
      },
      intervalMs: 1,
    });
    watchdog.watch("idle");
    watchdog.start();
    await sleep(20);
    watchdog.stop();
    expect(fired).toBe(false);
  });
});

describe("logger", () => {
  it("stores entries with timestamp, level, component and message", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "debug" });
    logger.info("component", "hello");
    const entry = logger.entries()[0];
    expect(entry?.timestamp).toBe(NOW);
    expect(entry?.level).toBe("info");
    expect(entry?.component).toBe("component");
    expect(entry?.message).toBe("hello");
  });

  it("filters entries below the minimum level", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "warn" });
    logger.debug("c", "hidden");
    logger.info("c", "hidden");
    logger.warn("c", "shown");
    logger.error("c", "shown");
    expect(logger.entries()).toHaveLength(2);
  });

  it("bounds the buffer so a long session cannot exhaust memory", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "debug", capacity: 10 });
    for (let i = 0; i < 100; i += 1) logger.info("c", `entry ${i}`);
    expect(logger.entries()).toHaveLength(10);
    expect(logger.entries().at(-1)?.message).toBe("entry 99");
  });

  it("clears entries", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "debug" });
    logger.info("c", "x");
    logger.clear();
    expect(logger.entries()).toHaveLength(0);
  });

  it("redacts credential-looking context values", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "debug" });
    logger.info("c", "auth", { token: "abc123", cookie: "session=xyz", safe: "visible" });
    const context = logger.entries()[0]?.context;
    expect(context?.["token"]).toBe("[redacted]");
    expect(context?.["cookie"]).toBe("[redacted]");
    expect(context?.["safe"]).toBe("visible");
  });

  it("redacts bearer tokens embedded in message text", () => {
    const logger = createLogger({ clock: fakeClock(), minLevel: "debug" });
    logger.info("c", "header was Authorization: Bearer abcdefghijklmnop");
    expect(logger.entries()[0]?.message).not.toContain("abcdefghijklmnop");
  });
});

describe("redaction", () => {
  it("redacts sensitive keys case-insensitively and across formats", () => {
    const result = redact({
      AccessToken: "x",
      "access-token": "y",
      access_token: "z",
      sessionId: "s",
      password: "p",
      safe: "keep",
    }) as Record<string, unknown>;
    expect(result["AccessToken"]).toBe("[redacted]");
    expect(result["access-token"]).toBe("[redacted]");
    expect(result["access_token"]).toBe("[redacted]");
    expect(result["sessionId"]).toBe("[redacted]");
    expect(result["password"]).toBe("[redacted]");
    expect(result["safe"]).toBe("keep");
  });

  it("redacts nested sensitive values", () => {
    const result = redact({ outer: { inner: { token: "secret", ok: 1 } } }) as {
      outer: { inner: Record<string, unknown> };
    };
    expect(result.outer.inner["token"]).toBe("[redacted]");
    expect(result.outer.inner["ok"]).toBe(1);
  });

  it("caps recursion depth so a cyclic object cannot hang", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it("handles primitive and null input", () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });

  it("converts errors into a safe shape", () => {
    const result = redact(new Error("failed")) as Record<string, unknown>;
    expect(result["name"]).toBe("Error");
    expect(result["message"]).toBe("failed");
  });
});
