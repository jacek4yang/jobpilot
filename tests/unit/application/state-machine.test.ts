import { describe, expect, it } from "vitest";
import type { AutomationEvent } from "../../../src/application/events";
import { reduce } from "../../../src/application/reducer";
import type { AutomationContext } from "../../../src/application/state";
import { emptyStats, initialContext, isActive } from "../../../src/application/state";
import type { JobDetail, JobSummary } from "../../../src/domain/job/job";
import type { Evaluation } from "../../../src/domain/rule";
import { asJobId, asPlatformId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;
const opts = { now: NOW, maxRetries: 2 };

const summary = (id = "job-1"): JobSummary => ({
  id: asJobId(id),
  platform: asPlatformId("boss"),
  title: "前端开发工程师",
  companyName: "示例科技",
  locationRaw: "北京·朝阳区",
  salaryRaw: "20-35K",
  idIsPlatformNative: true,
});

const detail = (id = "job-1"): JobDetail => ({
  ...summary(id),
  company: { id: "c1" as JobDetail["company"]["id"], name: "示例科技" },
  salary: { period: "month", raw: "20-35K", parsed: true, min: 20, max: 35 },
  location: { city: "北京", raw: "北京·朝阳区" },
  education: "bachelor",
  experience: "3-5",
  description: "负责前端开发",
  requirements: [],
  skills: ["TypeScript"],
  recruiters: [],
  capturedAt: NOW,
});

const accepted: Evaluation = {
  jobId: "job-1",
  accepted: true,
  score: 72,
  reasons: [{ ruleId: "soft.title-keywords", kind: "soft", delta: 10, message: "title match" }],
  rejections: [],
};

const rejectedByScore: Evaluation = {
  jobId: "job-1",
  accepted: false,
  score: 20,
  reasons: [
    {
      ruleId: "score.threshold",
      kind: "soft",
      delta: 0,
      message: "score 20 is below the accept threshold of 60",
    },
  ],
  rejections: [],
};

const rejectedByHardRule: Evaluation = {
  jobId: "job-1",
  accepted: false,
  score: 0,
  reasons: [{ ruleId: "hard.location", kind: "hard", delta: 0, message: "wrong city" }],
  rejections: [{ ruleId: "hard.location", kind: "hard", delta: 0, message: "wrong city" }],
};

const run = (
  context: AutomationContext,
  events: readonly AutomationEvent[],
): { context: AutomationContext; effects: readonly string[] } => {
  let current = context;
  const effects: string[] = [];
  for (const event of events) {
    const result = reduce(current, event, opts);
    current = result.context;
    effects.push(...result.effects.map((effect) => effect.type));
  }
  return { context: current, effects };
};

/** Drives the machine to the state a given event is expected to be handled in. */
const startContext = (): AutomationContext => run(initialContext(NOW), [{ type: "START" }]).context;

describe("automation state machine", () => {
  describe("start and stop", () => {
    it("starts from idle and requests a scan", () => {
      const { context, effects } = run(initialContext(NOW), [{ type: "START" }]);
      expect(context.state).toBe("scanning");
      expect(effects).toContain("scan-jobs");
    });

    it("ignores START while already active", () => {
      const started = startContext();
      const { effects } = run(started, [{ type: "START" }]);
      expect(effects).not.toContain("scan-jobs");
    });

    it("returns to idle and stops on STOP", () => {
      const { context, effects } = run(startContext(), [{ type: "STOP" }]);
      expect(context.state).toBe("idle");
      expect(effects).toContain("stop");
    });

    it("marks active states correctly", () => {
      expect(isActive("scanning")).toBe(true);
      expect(isActive("applying")).toBe(true);
      expect(isActive("idle")).toBe(false);
      expect(isActive("paused")).toBe(false);
    });
  });

  describe("scanning", () => {
    it("moves to evaluating after a scan with results", () => {
      const { context } = run(startContext(), [
        { type: "SCAN_COMPLETED", summaries: [summary()], skipped: 0 },
      ]);
      expect(context.state).toBe("evaluating");
      expect(context.stats.scanned).toBe(1);
    });

    it("returns to idle when the scan finds nothing", () => {
      const { context } = run(startContext(), [
        { type: "SCAN_COMPLETED", summaries: [], skipped: 0 },
      ]);
      expect(context.state).toBe("idle");
    });

    it("counts unparsed cards without failing", () => {
      const { context } = run(startContext(), [
        { type: "SCAN_COMPLETED", summaries: [summary()], skipped: 3 },
      ]);
      expect(context.stats.scanned).toBe(1);
      expect(context.lastMessage).toContain("3");
    });

    it("fails closed to failed on a scan error", () => {
      const { context, effects } = run(startContext(), [
        { type: "SCAN_FAILED", error: "boom", pageKind: "unknown" },
      ]);
      expect(context.state).toBe("failed");
      expect(context.lastError).toBe("boom");
      expect(effects).toContain("stop");
    });
  });

  describe("evaluation", () => {
    it("requests evaluation when a job detail loads", () => {
      const { context, effects } = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]);
      expect(context.state).toBe("evaluating");
      expect(effects).toContain("evaluate-job");
    });

    it("counts an accepted job", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const result = run(context, [{ type: "EVALUATED", evaluation: accepted }]);
      expect(result.context.stats.accepted).toBe(1);
      expect(result.context.state).toBe("validating");
    });

    it("counts a score-rejected job as skipped, not blocked", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const result = run(context, [{ type: "EVALUATED", evaluation: rejectedByScore }]);
      expect(result.context.stats.skipped).toBe(1);
      expect(result.context.state).toBe("cooldown");
    });

    it("pauses when a hard rule rejects, recording the reason", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const result = run(context, [{ type: "EVALUATED", evaluation: rejectedByHardRule }]);
      expect(result.context.state).toBe("paused");
      expect(result.context.pauseReason).toBeDefined();
      expect(result.effects).toContain("record-diagnostics");
    });

    it("never mutates the context it was given", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const before = JSON.stringify(context);
      reduce(context, { type: "EVALUATED", evaluation: accepted }, opts);
      expect(JSON.stringify(context)).toBe(before);
    });
  });

  describe("applying and verification", () => {
    const approvedContext = (): AutomationContext =>
      run(run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context, [
        { type: "EVALUATED", evaluation: accepted },
      ]).context;

    it("moves to applying and requests the apply effect", () => {
      const { context, effects } = run(approvedContext(), [
        { type: "APPLY_STARTED", job: detail() },
      ]);
      expect(context.state).toBe("applying");
      expect(effects).toContain("apply-job");
    });

    it("verifies after a submitted result rather than trusting it", () => {
      const applying = run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context;
      const { context, effects } = run(applying, [
        { type: "APPLY_SUBMITTED", evidence: "toast appeared" },
      ]);
      expect(context.state).toBe("verifying");
      expect(effects).toContain("verify-application");
    });

    it("pauses on an ambiguous apply outcome instead of retrying", () => {
      const applying = run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context;
      const { context, effects } = run(applying, [
        { type: "APPLY_NEEDS_CONFIRMATION", evidence: "no confirmation seen" },
      ]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("ambiguous-state");
      // Crucially: no second apply is attempted.
      expect(effects).not.toContain("apply-job");
    });

    it("counts an application only once verification confirms it", () => {
      const verifying = run(
        run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context,
        [{ type: "APPLY_SUBMITTED", evidence: "ok" }],
      ).context;
      const { context } = run(verifying, [
        { type: "VERIFICATION_CONFIRMED", evidence: "status shows applied" },
      ]);
      expect(context.stats.applied).toBe(1);
      expect(context.sessionApplications).toBe(1);
      expect(context.applicationTimestamps).toHaveLength(1);
      expect(context.currentJob).toBeUndefined();
    });

    it("does not count an application when verification is negative", () => {
      const verifying = run(
        run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context,
        [{ type: "APPLY_SUBMITTED", evidence: "ok" }],
      ).context;
      const { context } = run(verifying, [
        { type: "VERIFICATION_NEGATIVE", evidence: "no application found" },
      ]);
      expect(context.stats.applied).toBe(0);
      expect(context.state).toBe("cooldown");
    });

    it("fails closed when verification is indeterminate", () => {
      const verifying = run(
        run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context,
        [{ type: "APPLY_SUBMITTED", evidence: "ok" }],
      ).context;
      const { context } = run(verifying, [
        { type: "VERIFICATION_INDETERMINATE", evidence: "page did not settle" },
      ]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("ambiguous-state");
    });

    it("retries a retryable failure while attempts remain", () => {
      const applying = run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context;
      const { context } = run(applying, [
        { type: "APPLY_FAILED", error: "network", retryable: true },
      ]);
      expect(context.state).toBe("cooldown");
      expect(context.consecutiveFailures).toBe(1);
    });

    it("gives up and stops once retries are exhausted", () => {
      const applying = run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context;
      const first = run(applying, [
        { type: "APPLY_FAILED", error: "network", retryable: true },
      ]).context;
      const second = run(first, [
        { type: "APPLY_FAILED", error: "network", retryable: true },
      ]).context;
      const third = run(second, [{ type: "APPLY_FAILED", error: "network", retryable: true }]);
      // maxRetries is 2, so the third consecutive failure is terminal.
      expect(third.context.state).toBe("failed");
      expect(third.effects).toContain("stop");
    });

    it("does not retry a non-retryable failure", () => {
      const applying = run(approvedContext(), [{ type: "APPLY_STARTED", job: detail() }]).context;
      const { context } = run(applying, [
        { type: "APPLY_FAILED", error: "form rejected", retryable: false },
      ]);
      expect(context.state).toBe("failed");
    });
  });

  describe("fail-closed safety signals", () => {
    const cases: readonly (readonly [AutomationEvent, string])[] = [
      [{ type: "BLOCKED", reason: "captcha", evidence: "captcha widget" }, "captcha"],
      [{ type: "BLOCKED", reason: "risk-control", evidence: "risk page" }, "risk-control"],
      [{ type: "BLOCKED", reason: "login-expired", evidence: "login form" }, "login-expired"],
      [{ type: "BLOCKED", reason: "unknown-dom", evidence: "no anchors" }, "unknown-dom"],
      [{ type: "BLOCKED", reason: "selector-missing", evidence: ".apply-btn" }, "selector-missing"],
      [{ type: "BLOCKED", reason: "ambiguous-state", evidence: "two buttons" }, "ambiguous-state"],
      [{ type: "BLOCKED", reason: "rate-limited", evidence: "429" }, "rate-limited"],
    ];

    for (const [event, expectedKind] of cases) {
      it(`pauses with reason "${expectedKind}"`, () => {
        const { context, effects } = run(startContext(), [event]);
        expect(context.state).toBe("paused");
        expect(context.pauseReason?.kind).toBe(expectedKind);
        expect(effects).toContain("record-diagnostics");
        expect(effects).toContain("notify");
      });
    }

    it("pauses on a user request", () => {
      const { context } = run(startContext(), [{ type: "PAUSE", reason: { kind: "user" } }]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("user");
    });

    it("pauses on a watchdog timeout", () => {
      const { context } = run(startContext(), [
        { type: "WATCHDOG_TIMEOUT", evidence: "stuck in applying" },
      ]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("watchdog");
    });

    it("pauses when the route changes mid-action", () => {
      const { context } = run(startContext(), [{ type: "PAGE_CHANGED", pageKind: "job-detail" }]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("page-changed");
    });

    it("ignores PAGE_CHANGED while idle rather than pausing pointlessly", () => {
      const { context } = run(initialContext(NOW), [
        { type: "PAGE_CHANGED", pageKind: "job-list" },
      ]);
      expect(context.state).toBe("idle");
    });

    it("ignores work events while paused", () => {
      const paused = run(startContext(), [
        { type: "BLOCKED", reason: "captcha", evidence: "x" },
      ]).context;
      const { context, effects } = run(paused, [{ type: "JOB_LOADED", job: detail() }]);
      expect(context.state).toBe("paused");
      expect(effects).not.toContain("evaluate-job");
    });
  });

  describe("pause and resume", () => {
    it("resumes from paused by restarting the scan", () => {
      const paused = run(startContext(), [
        { type: "BLOCKED", reason: "captcha", evidence: "x" },
      ]).context;
      const { context, effects } = run(paused, [{ type: "RESUME" }]);
      expect(context.state).toBe("scanning");
      expect(context.pauseReason).toBeUndefined();
      expect(effects).toContain("scan-jobs");
    });

    it("resumes from failed and clears the previous error", () => {
      const failed = run(startContext(), [
        { type: "SCAN_FAILED", error: "boom", pageKind: "unknown" },
      ]).context;
      const { context } = run(failed, [{ type: "RESUME" }]);
      expect(context.state).toBe("scanning");
      expect(context.lastError).toBeUndefined();
    });

    it("ignores RESUME when not halted", () => {
      const { context } = run(startContext(), [{ type: "RESUME" }]);
      expect(context.state).toBe("scanning");
    });

    it("never resumes into the middle of an apply", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const paused = run(context, [{ type: "PAUSE", reason: { kind: "user" } }]).context;
      const { context: resumed } = run(paused, [{ type: "RESUME" }]);
      // Resuming restarts from scanning so a half-done apply is re-verified.
      expect(resumed.state).toBe("scanning");
    });
  });

  describe("session limits", () => {
    it("pauses when the session limit is reached", () => {
      const { context } = run(startContext(), [{ type: "SESSION_LIMIT_REACHED", limit: 20 }]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("session-limit");
    });
  });

  describe("cooldown", () => {
    it("returns to scanning after a cooldown elapses", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const cooled = run(context, [{ type: "EVALUATED", evaluation: rejectedByScore }]).context;
      expect(cooled.state).toBe("cooldown");
      const { context: next, effects } = run(cooled, [{ type: "COOLDOWN_ELAPSED" }]);
      expect(next.state).toBe("scanning");
      expect(effects).toContain("scan-jobs");
    });

    it("ignores COOLDOWN_ELAPSED outside cooldown", () => {
      const { context } = run(startContext(), [{ type: "COOLDOWN_ELAPSED" }]);
      expect(context.state).toBe("scanning");
    });
  });

  describe("queue depth", () => {
    it("tracks queue depth without changing state", () => {
      const started = startContext();
      const { context } = run(started, [{ type: "QUEUE_CHANGED", depth: 7 }]);
      expect(context.queueDepth).toBe(7);
      expect(context.state).toBe("scanning");
    });
  });

  describe("invariants", () => {
    it("keeps stats counters monotonically non-decreasing", () => {
      const events: readonly AutomationEvent[] = [
        { type: "START" },
        { type: "SCAN_COMPLETED", summaries: [summary(), summary("job-2")], skipped: 0 },
        { type: "JOB_LOADED", job: detail() },
        { type: "EVALUATED", evaluation: accepted },
        { type: "APPLY_STARTED", job: detail() },
        { type: "APPLY_SUBMITTED", evidence: "ok" },
        { type: "VERIFICATION_CONFIRMED", evidence: "ok" },
      ];
      let current = initialContext(NOW);
      let previous = emptyStats;
      for (const event of events) {
        current = reduce(current, event, opts).context;
        expect(current.stats.scanned).toBeGreaterThanOrEqual(previous.scanned);
        expect(current.stats.accepted).toBeGreaterThanOrEqual(previous.accepted);
        expect(current.stats.applied).toBeGreaterThanOrEqual(previous.applied);
        expect(current.stats.skipped).toBeGreaterThanOrEqual(previous.skipped);
        previous = current.stats;
      }
      expect(current.stats.applied).toBe(1);
    });

    it("records stateSince on every state change", () => {
      const result = reduce(
        initialContext(NOW),
        { type: "START" },
        { now: NOW + 500, maxRetries: 2 },
      );
      expect(result.context.stateSince).toBe(NOW + 500);
    });
  });
});
