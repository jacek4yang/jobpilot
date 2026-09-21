import { describe, expect, it } from "vitest";
import type { AutomationEvent, Effect } from "../../../src/application/events";
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
      expect(isActive("contacting")).toBe(true);
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

    it("skips a hard-rule rejection and continues the finite batch", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const result = run(context, [{ type: "EVALUATED", evaluation: rejectedByHardRule }]);
      expect(result.context.state).toBe("cooldown");
      expect(result.context.stats.skipped).toBe(1);
      expect(result.effects).toContain("schedule-cooldown");
    });

    it("never mutates the context it was given", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const before = JSON.stringify(context);
      reduce(context, { type: "EVALUATED", evaluation: accepted }, opts);
      expect(JSON.stringify(context)).toBe(before);
    });
  });

  describe("authoritative communication", () => {
    const approvedContext = (): AutomationContext =>
      run(run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context, [
        { type: "EVALUATED", evaluation: accepted },
      ]).context;

    it("moves to contacting and requests the one communication effect", () => {
      const { context, effects } = run(approvedContext(), [
        { type: "CONTACT_STARTED", job: detail() },
      ]);
      expect(context.state).toBe("contacting");
      expect(effects).toContain("contact-job");
    });

    it("pauses on an uncertain send instead of retrying", () => {
      const contacting = run(approvedContext(), [
        { type: "CONTACT_STARTED", job: detail() },
      ]).context;
      const { context, effects } = run(contacting, [
        { type: "CONTACT_UNCERTAIN", evidence: "no outgoing message observed" },
      ]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("ambiguous-state");
      expect(context.lastTerminalReason).toBe("needs-confirmation");
      expect(effects).not.toContain("contact-job");
    });

    it("counts a contact only after outgoing-message evidence confirms it", () => {
      const contacting = run(approvedContext(), [
        { type: "CONTACT_STARTED", job: detail() },
      ]).context;
      const { context, effects } = run(contacting, [
        { type: "CONTACT_CONFIRMED", evidence: "outgoing count increased" },
      ]);
      expect(context.stats.applied).toBe(1);
      expect(context.sessionApplications).toBe(1);
      expect(context.applicationTimestamps).toHaveLength(1);
      expect(context.currentJob).toBeUndefined();
      expect(context.state).toBe("cooldown");
      expect(effects).toContain("schedule-cooldown");
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
        { type: "WATCHDOG_TIMEOUT", evidence: "stuck in contacting" },
      ]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("watchdog");
    });

    it("pauses when the route changes mid-action", () => {
      const { context } = run(startContext(), [{ type: "PAGE_CHANGED", pageKind: "job-detail" }]);
      expect(context.state).toBe("paused");
      expect(context.pauseReason?.kind).toBe("page-changed");
    });

    it("allows the expected detail-to-chat transition while contacting", () => {
      const contacting: AutomationContext = { ...startContext(), state: "contacting" };
      const { context, effects } = run(contacting, [{ type: "PAGE_CHANGED", pageKind: "chat" }]);
      expect(context.state).toBe("contacting");
      expect(effects).toHaveLength(0);
    });

    it("allows the selected card to open its detail drawer while loading", () => {
      const opening: AutomationContext = { ...startContext(), state: "opening" };
      const { context, effects } = run(opening, [{ type: "PAGE_CHANGED", pageKind: "job-detail" }]);
      expect(context.state).toBe("opening");
      expect(effects).toHaveLength(0);
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
    it("completes instead of rescanning after the finite batch is drained", () => {
      const context = run(startContext(), [{ type: "JOB_LOADED", job: detail() }]).context;
      const cooled = run(context, [{ type: "EVALUATED", evaluation: rejectedByScore }]).context;
      expect(cooled.state).toBe("cooldown");
      const { context: next, effects } = run(cooled, [{ type: "COOLDOWN_ELAPSED" }]);
      expect(next.state).toBe("idle");
      expect(next.lastTerminalReason).toBe("completed");
      expect(effects).not.toContain("scan-jobs");
    });

    it("ignores COOLDOWN_ELAPSED outside cooldown", () => {
      const { context } = run(startContext(), [{ type: "COOLDOWN_ELAPSED" }]);
      expect(context.state).toBe("scanning");
    });
  });

  describe("batch run engine", () => {
    /** The load-job effect, asserted present so payload checks never see undefined. */
    const loadJobEffectOf = (effects: readonly Effect[]): Extract<Effect, { type: "load-job" }> => {
      const found = effects.find((effect) => effect.type === "load-job");
      if (found === undefined || found.type !== "load-job") {
        throw new Error("expected a load-job effect");
      }
      return found;
    };

    it("bridges SCAN_COMPLETED into the per-job pipeline and drains one job per cooldown", () => {
      // START → scan completes: the first summary loads immediately and the
      // whole scan waits in the pending queue.
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      expect(result.context.state).toBe("evaluating");
      expect(result.context.pendingSummaries).toHaveLength(2);
      expect(loadJobEffectOf(result.effects).summary.id).toBe(summary().id);

      // Loading a job removes it from the queue: pendingSummaries holds only
      // jobs that have NOT started their cycle.
      result = reduce(result.context, { type: "JOB_LOADED", job: detail() }, opts);
      expect(result.effects.map((effect) => effect.type)).toContain("evaluate-job");
      expect(result.context.pendingSummaries).toHaveLength(1);

      // evaluate → accepted → apply → verify → settle in cooldown.
      result = reduce(result.context, { type: "EVALUATED", evaluation: accepted }, opts);
      expect(result.context.state).toBe("validating");
      result = reduce(result.context, { type: "CONTACT_STARTED", job: detail() }, opts);
      result = reduce(result.context, { type: "CONTACT_CONFIRMED", evidence: "ok" }, opts);
      expect(result.context.state).toBe("cooldown");
      // Settling one job must not consume the rest of the batch.
      expect(result.context.pendingSummaries.map((entry) => entry.id)).toEqual([
        summary("job-2").id,
      ]);

      // The first cooldown drains summaries[1]; the queue is now empty.
      result = reduce(result.context, { type: "COOLDOWN_ELAPSED" }, opts);
      expect(result.context.state).toBe("evaluating");
      expect(result.context.pendingSummaries).toHaveLength(0);
      expect(loadJobEffectOf(result.effects).summary.id).toBe(summary("job-2").id);

      // Settle the second job (score rejection is a normal settle) — the next
      // cooldown finds the queue drained and terminates the finite batch.
      result = reduce(result.context, { type: "JOB_LOADED", job: detail("job-2") }, opts);
      result = reduce(result.context, { type: "EVALUATED", evaluation: rejectedByScore }, opts);
      expect(result.context.state).toBe("cooldown");
      result = reduce(result.context, { type: "COOLDOWN_ELAPSED" }, opts);
      expect(result.context.state).toBe("idle");
      expect(result.context.lastTerminalReason).toBe("completed");
      expect(result.effects.map((effect) => effect.type)).not.toContain("scan-jobs");
    });

    it("runs every scanned job exactly once, however long the scan was", () => {
      const summaries = [summary(), summary("job-2"), summary("job-3")];
      const loaded: string[] = [];
      let result = reduce(startContext(), { type: "SCAN_COMPLETED", summaries, skipped: 0 }, opts);
      // Consume the whole batch: each cooldown must hand out exactly one new
      // job — no re-loads, no silent drops.
      for (let index = 0; index < summaries.length; index += 1) {
        expect(result.context.state).toBe("evaluating");
        const effect = loadJobEffectOf(result.effects);
        loaded.push(effect.summary.id);
        let step = reduce(
          result.context,
          {
            type: "JOB_LOADED",
            job: detail(effect.summary.id),
          },
          opts,
        );
        step = reduce(step.context, { type: "EVALUATED", evaluation: rejectedByScore }, opts);
        expect(step.context.state).toBe("cooldown");
        result = reduce(step.context, { type: "COOLDOWN_ELAPSED" }, opts);
      }
      expect(loaded).toEqual(summaries.map((entry) => entry.id));
      // Drained: a finite operator-selected batch is complete.
      expect(result.context.state).toBe("idle");
      expect(result.context.lastTerminalReason).toBe("completed");
    });

    it("advances to the next pending job after a rejected evaluation", () => {
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      result = reduce(result.context, { type: "JOB_LOADED", job: detail() }, opts);
      expect(result.context.pendingSummaries).toHaveLength(1);
      result = reduce(result.context, { type: "EVALUATED", evaluation: rejectedByScore }, opts);
      expect(result.context.state).toBe("cooldown");

      result = reduce(result.context, { type: "COOLDOWN_ELAPSED" }, opts);
      expect(result.context.state).toBe("evaluating");
      expect(result.context.pendingSummaries).toHaveLength(0);
      expect(loadJobEffectOf(result.effects).summary.id).toBe(summary("job-2").id);
    });

    it("clears the pending batch on STOP", () => {
      const scanned = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      ).context;
      expect(scanned.pendingSummaries).toHaveLength(2);

      const { context, effects } = reduce(scanned, { type: "STOP" }, opts);
      expect(context.state).toBe("idle");
      expect(context.pendingSummaries).toHaveLength(0);
      expect(effects.map((effect) => effect.type)).toContain("stop");
    });

    it("keeps the pending batch across PAUSE and rescans on RESUME", () => {
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      result = reduce(result.context, { type: "JOB_LOADED", job: detail() }, opts);
      result = reduce(result.context, { type: "EVALUATED", evaluation: rejectedByScore }, opts);
      expect(result.context.state).toBe("cooldown");
      expect(result.context.pendingSummaries).toHaveLength(1);

      result = reduce(result.context, { type: "PAUSE", reason: { kind: "user" } }, opts);
      expect(result.context.state).toBe("paused");
      // Pausing is not an abort: the batch is preserved...
      expect(result.context.pendingSummaries).toHaveLength(1);

      // ...but a halted machine never consumes it: COOLDOWN_ELAPSED only acts
      // from cooldown.
      const ignored = reduce(result.context, { type: "COOLDOWN_ELAPSED" }, opts);
      expect(ignored.context.state).toBe("paused");
      expect(ignored.context.pendingSummaries).toHaveLength(1);
      expect(ignored.effects).toHaveLength(0);

      // Resume restarts from scanning, exactly as it did before the batch
      // engine existed; the fresh scan will overwrite the stale queue.
      const resumed = reduce(result.context, { type: "RESUME" }, opts);
      expect(resumed.context.state).toBe("scanning");
      expect(resumed.effects.map((effect) => effect.type)).toContain("scan-jobs");
    });

    it("never consumes the pending batch after a page change halts the run", () => {
      // Land in evaluating (an active state) with the batch still pending, then
      // let the route change halt the machine mid-cycle.
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      result = reduce(result.context, { type: "JOB_LOADED", job: detail() }, opts);
      expect(result.context.state).toBe("evaluating");
      expect(result.context.pendingSummaries).toHaveLength(1);

      result = reduce(result.context, { type: "PAGE_CHANGED", pageKind: "job-list" }, opts);
      expect(result.context.state).toBe("paused");
      expect(result.context.pendingSummaries).toHaveLength(1);

      const ignored = reduce(result.context, { type: "COOLDOWN_ELAPSED" }, opts);
      expect(ignored.context.state).toBe("paused");
      expect(ignored.context.pendingSummaries).toHaveLength(1);
    });

    it("treats a fresh scan as a new batch, replacing the pending queue", () => {
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      expect(result.context.pendingSummaries).toHaveLength(2);

      result = reduce(
        result.context,
        {
          type: "SCAN_COMPLETED",
          summaries: [summary("job-3")],
          skipped: 0,
        },
        opts,
      );
      expect(result.context.pendingSummaries).toHaveLength(1);
      expect(result.context.pendingSummaries[0]?.id).toBe(summary("job-3").id);
      expect(loadJobEffectOf(result.effects).summary.id).toBe(summary("job-3").id);
    });

    it("clears the pending queue when the scan finds nothing", () => {
      let result = reduce(
        startContext(),
        {
          type: "SCAN_COMPLETED",
          summaries: [summary(), summary("job-2")],
          skipped: 0,
        },
        opts,
      );
      expect(result.context.pendingSummaries).toHaveLength(2);

      result = reduce(result.context, { type: "SCAN_COMPLETED", summaries: [], skipped: 0 }, opts);
      expect(result.context.state).toBe("idle");
      expect(result.context.pendingSummaries).toHaveLength(0);
      expect(result.effects.map((effect) => effect.type)).not.toContain("load-job");
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
        { type: "CONTACT_STARTED", job: detail() },
        { type: "CONTACT_CONFIRMED", evidence: "ok" },
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
