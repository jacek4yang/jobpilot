import { describe, expect, it } from "vitest";
import type { AutomationEvent } from "../../../src/application/events";
import { createApplicationHistory } from "../../../src/application/history";
import { createOrchestrator, type OrchestratorDeps } from "../../../src/application/orchestrator";
import { type AutomationContext, initialContext } from "../../../src/application/state";
import type { RuleEngine } from "../../../src/domain/engine";
import type { JobDetail, JobSummary } from "../../../src/domain/job/job";
import type { Evaluation } from "../../../src/domain/rule";
import { asJobId, asPlatformId } from "../../../src/domain/support/ids";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";
import type { JobPlatform } from "../../../src/ports/job-platform";
import type { Storage } from "../../../src/ports/storage";

const NOW = 1_700_000_000_000;

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

/** A platform whose loadJob records the call so ordering can be asserted. */
const makePlatform = (loadJob: JobPlatform["loadJob"]): JobPlatform => ({
  id: "boss",
  displayName: "BOSS Zhipin",
  detectPage: () => "job-list",
  scanJobs: async () => [],
  loadJob,
  apply: async (job) => ({ outcome: { kind: "submitted", evidence: "ok" }, jobId: job.id }),
  verifyApplication: async (job) => ({
    outcome: { kind: "confirmed", evidence: "ok" },
    jobId: job.id,
  }),
});

/** An engine that always returns the given evaluation. */
const makeEngine = (evaluation: Evaluation): RuleEngine => ({
  hardRules: [],
  softRules: [],
  evaluate: () => evaluation,
});

const storageStub = (): Storage => ({
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
  keys: async () => [],
});

interface DepsOverrides {
  readonly platform?: JobPlatform;
  readonly engine?: RuleEngine;
  readonly history?: ReturnType<typeof createApplicationHistory>;
  readonly dispatch?: (event: AutomationEvent) => void;
  readonly isOperatorSelected?: (jobId: string) => boolean;
}

const makeDeps = (overrides: DepsOverrides = {}): OrchestratorDeps => ({
  platform: overrides.platform ?? makePlatform(async (job) => detail(String(job.id))),
  engine: overrides.engine ?? makeEngine(rejectedByScore),
  history: overrides.history ?? createApplicationHistory(),
  storage: storageStub(),
  logger: createNullLogger(),
  clock: { now: () => NOW },
  random: { next: () => 0.5 },
  config: {
    hard: {
      cities: [],
      minSalaryK: 0,
      maxSalaryK: 0,
      education: [],
      experience: [],
      includeKeywords: [],
      excludeKeywords: [],
      companyBlacklist: [],
      excludeOutsourcing: false,
      excludeHeadhunter: false,
    },
    scoring: {
      baseScore: 50,
      acceptThreshold: 60,
      titleKeywords: [],
      descriptionKeywords: [],
      preferredSkills: [],
      preferredCities: [],
    },
  },
  version: "test",
  persist: async () => {},
  dispatch: overrides.dispatch ?? (() => {}),
  notify: () => {},
  onDiagnostic: () => {},
  delayPolicy: { minActionDelayMs: 0, maxActionDelayMs: 0 },
  sessionPolicy: { maxApplicationsPerSession: 5, maxApplicationsPerHour: 15, maxRetries: 2 },
  isOperatorSelected: overrides.isOperatorSelected ?? (() => false),
});

/** A context already at the session cap, so APPLY_STARTED is never scheduled. */
const cappedContext = (): AutomationContext => ({
  ...initialContext(NOW),
  state: "evaluating",
  currentJob: detail(),
  sessionApplications: 5,
});

describe("orchestrator load-job", () => {
  it("dispatches JOB_LOADING before the platform load and JOB_LOADED after it", async () => {
    const sequence: string[] = [];
    const events: AutomationEvent[] = [];
    const platform = makePlatform(async (job) => {
      sequence.push("platform.loadJob");
      return detail(String(job.id));
    });
    const orchestrator = createOrchestrator(
      makeDeps({
        platform,
        dispatch: (event) => {
          sequence.push(`dispatch:${event.type}`);
          events.push(event);
        },
      }),
    );

    await orchestrator.runEffect({ type: "load-job", summary: summary() }, initialContext(NOW));

    expect(sequence).toEqual(["dispatch:JOB_LOADING", "platform.loadJob", "dispatch:JOB_LOADED"]);
    expect(events.map((event) => event.type)).toEqual(["JOB_LOADING", "JOB_LOADED"]);
  });

  it("dispatches JOB_LOAD_FAILED when the platform load rejects", async () => {
    const events: AutomationEvent[] = [];
    const platform = makePlatform(async () => {
      throw new Error("drawer never opened");
    });
    const orchestrator = createOrchestrator(
      makeDeps({ platform, dispatch: (event) => events.push(event) }),
    );

    await orchestrator.runEffect({ type: "load-job", summary: summary() }, initialContext(NOW));

    expect(events.map((event) => event.type)).toEqual(["JOB_LOADING", "JOB_LOAD_FAILED"]);
    const failed = events[1];
    expect(failed?.type).toBe("JOB_LOAD_FAILED");
    if (failed?.type === "JOB_LOAD_FAILED") expect(failed.error).toContain("drawer never opened");
  });
});

describe("orchestrator evaluate-job — operator selection", () => {
  it("force-accepts an operator-selected job and records the manual-select reason as approved", async () => {
    const events: AutomationEvent[] = [];
    const history = createApplicationHistory();
    const orchestrator = createOrchestrator(
      makeDeps({
        engine: makeEngine(rejectedByScore),
        history,
        dispatch: (event) => events.push(event),
        isOperatorSelected: () => true,
      }),
    );

    await orchestrator.runEffect({ type: "evaluate-job", job: detail() }, cappedContext());

    const evaluated = events.find((event) => event.type === "EVALUATED");
    expect(evaluated?.type).toBe("EVALUATED");
    if (evaluated?.type !== "EVALUATED") throw new Error("expected EVALUATED");
    expect(evaluated.evaluation.accepted).toBe(true);
    const manual = evaluated.evaluation.reasons.find((reason) => reason.ruleId === "manual.select");
    expect(manual?.message).toBe("手动选择（勾选）");

    // The history must record the FINAL evaluation: approved, manual reason
    // included, and the session cap must still gate APPLY_STARTED (the capped
    // context triggers SESSION_LIMIT_REACHED instead).
    const record = history.get(asJobId("job-1"));
    expect(record?.status).toBe("approved");
    expect(record?.reasons).toContain("手动选择（勾选）");
    expect(events.some((event) => event.type === "APPLY_STARTED")).toBe(false);
    expect(events.some((event) => event.type === "SESSION_LIMIT_REACHED")).toBe(true);
  });

  it("keeps the engine verdict for a job the operator did not select", async () => {
    const events: AutomationEvent[] = [];
    const history = createApplicationHistory();
    const orchestrator = createOrchestrator(
      makeDeps({
        engine: makeEngine(rejectedByScore),
        history,
        dispatch: (event) => events.push(event),
        isOperatorSelected: () => false,
      }),
    );

    await orchestrator.runEffect({ type: "evaluate-job", job: detail() }, cappedContext());

    const evaluated = events.find((event) => event.type === "EVALUATED");
    if (evaluated?.type !== "EVALUATED") throw new Error("expected EVALUATED");
    expect(evaluated.evaluation.accepted).toBe(false);
    expect(evaluated.evaluation.reasons.some((reason) => reason.ruleId === "manual.select")).toBe(
      false,
    );
    expect(history.get(asJobId("job-1"))?.status).toBe("rejected");
  });
});
