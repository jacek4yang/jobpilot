import { describe, expect, it, vi } from "vitest";
import type { CommunicationOutcome } from "../../../src/application/communication-runner";
import {
  type CommunicationServiceDeps,
  createCommunicationService,
} from "../../../src/application/communication-service";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";
import {
  type CommunicationIntent,
  createIntent,
  hasSendBeenAttempted,
  markClickDispatched,
} from "../../../src/domain/communication/intent";
import { createTemplate } from "../../../src/domain/communication/template";
import type { JobDetail } from "../../../src/domain/job/job";
import { asCompanyId, asJobId, asPlatformId, asRecruiterId } from "../../../src/domain/support/ids";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";

const NOW = 1_700_000_000_000;

const job = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  id: asJobId("job-1"),
  platform: asPlatformId("boss"),
  title: "后端开发工程师",
  companyName: "示例科技有限公司",
  locationRaw: "北京·朝阳区",
  salaryRaw: "20-35K",
  idIsPlatformNative: true,
  url: "https://www.zhipin.com/job_detail/abc.html",
  company: { id: asCompanyId("示例科技"), name: "示例科技有限公司" },
  salary: { period: "month", raw: "20-35K", parsed: true, min: 20, max: 35 },
  location: { city: "北京", raw: "北京·朝阳区" },
  education: "bachelor",
  experience: "3-5",
  description: "后端开发",
  requirements: [],
  skills: ["Rust"],
  recruiters: [{ id: asRecruiterId("li"), name: "李女士" }],
  capturedAt: NOW,
  ...overrides,
});

const recorder = () =>
  createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 0,
    capacity: 200,
    minLevel: "trace",
  });

interface Harness {
  readonly service: ReturnType<typeof createCommunicationService>;
  readonly rec: ReturnType<typeof recorder>;
  readonly runnerCalls: CommunicationIntent[];
  readonly persisted: CommunicationIntent[];
  readonly setHealth: (healthy: boolean) => void;
  readonly lastIntent: () => CommunicationIntent | undefined;
}

const harness = (overrides: Partial<CommunicationServiceDeps> = {}): Harness => {
  const rec = recorder();
  const runnerCalls: CommunicationIntent[] = [];
  let persisted: CommunicationIntent | undefined;
  let healthy = true;

  const recall: CommunicationIntent[] = [];
  const setPersisted = (value: CommunicationIntent | undefined): void => {
    persisted = value;
    if (value !== undefined) recall.push(value);
  };

  const outcome: CommunicationOutcome = { kind: "sent", evidence: "outgoing bubble observed" };

  const service = createCommunicationService({
    runner: {
      run: async (intent) => {
        runnerCalls.push(intent);
        return outcome;
      },
    },
    recorder: rec,
    clock: { now: () => NOW },
    logger: createNullLogger(),
    baseGateInput: () => ({
      mode: "assist",
      humanVerificationActive: false,
      storage: healthy ? { healthy: true } : { healthy: false, lastFailure: "quota exceeded" },
      isQueueOwner: true,
      sessionLimitReached: false,
      hourlyLimitReached: false,
      rateLimited: false,
    }),
    verifyChat: () => ({ verified: true, detail: "job id matched" }),
    isDraftPresent: () => false,
    outgoingCount: () => 0,
    readPersistedIntent: () => persisted,
    persistIntent: async (intent) => {
      setPersisted(intent);
    },
    clearIntent: async () => {
      persisted = undefined;
    },
    storageHealth: () =>
      healthy ? { healthy: true } : { healthy: false, lastFailure: "quota exceeded" },
    templates: () => [
      createTemplate({
        id: "t1",
        name: "Default",
        content: "您好，我想应聘{{jobTitle}}",
        isDefault: true,
      }),
    ],
    newIntentId: () => "txn-1",
    ...overrides,
  });

  return {
    service,
    rec,
    runnerCalls,
    persisted: recall,
    setHealth: (next) => {
      healthy = next;
    },
    lastIntent: () => persisted,
  };
};

describe("communication service", () => {
  describe("the happy path", () => {
    it("persists the intent before delegating to the runner", async () => {
      const h = harness();
      const result = await h.service.communicate({ job: job() });

      expect(result.kind).toBe("sent");
      // The invariant: an intent exists before any click can happen.
      expect(h.persisted.length).toBeGreaterThanOrEqual(1);
      expect(h.persisted[0]?.jobId).toBe("job-1");
      expect(h.runnerCalls).toHaveLength(1);
    });

    it("records the message by metadata only, never its text", async () => {
      const h = harness();
      await h.service.communicate({ job: job() });

      const created = h.rec
        .events()
        .find((event) => event.event === "communication.intent.created");
      expect(created).toBeDefined();
      const serialised = JSON.stringify(created);
      // The rendered message contains the job title; the event must not carry
      // the message body itself.
      expect(serialised).not.toContain("您好，我想应聘");
      expect(created?.data?.["messageLength"]).toBeGreaterThan(0);
      expect(created?.data?.["templateId"]).toBe("t1");
    });

    it("captures the outgoing baseline from the adapter before sending", async () => {
      const h = harness({ outgoingCount: () => 3 });
      await h.service.communicate({ job: job() });
      expect(h.persisted[0]?.outgoingBaseline).toBe(3);
    });

    it("records the identity expectations used to verify the chat", async () => {
      const h = harness();
      await h.service.communicate({ job: job() });
      const intent = h.persisted[0];
      expect(intent?.expectedJobTitle).toBe("后端开发工程师");
      expect(intent?.expectedCompany).toBe("示例科技有限公司");
      expect(intent?.expectedRecruiter).toBe("李女士");
    });
  });

  describe("no send without persisted intent", () => {
    it("refuses when persistence is unavailable", async () => {
      const h = harness();
      h.setHealth(false);
      const result = await h.service.communicate({ job: job() });

      expect(result.kind).toBe("refused");
      expect(h.runnerCalls).toHaveLength(0);
    });

    it("reports the storage reason in plain language", async () => {
      const h = harness();
      h.setHealth(false);
      const result = await h.service.communicate({ job: job() });
      expect(result.kind === "refused" ? result.message : "").toContain(
        "Persistence is unavailable",
      );
    });

    it("logs an invariant violation when storage is unhealthy", async () => {
      const h = harness();
      h.setHealth(false);
      await h.service.communicate({ job: job() });
      expect(h.rec.criticalEvents().some((e) => e.event === "error.invariant_violation")).toBe(
        true,
      );
    });
  });

  describe("no send without a verified chat", () => {
    it("refuses when the chat cannot be confirmed", async () => {
      const h = harness({
        verifyChat: () => ({ verified: false, detail: "identity insufficient" }),
      });
      const result = await h.service.communicate({ job: job() });

      expect(result.kind).toBe("refused");
      expect(h.runnerCalls).toHaveLength(0);
      // Nothing irreversible happened, so no intent should have been created.
      expect(h.persisted).toHaveLength(0);
    });

    it("logs the chat invariant violation", async () => {
      const h = harness({ verifyChat: () => ({ verified: false, detail: "mismatch" }) });
      await h.service.communicate({ job: job() });
      const violation = h.rec.criticalEvents().find((e) => e.event === "error.invariant_violation");
      expect(violation?.data?.["invariant"]).toBe("NO_SEND_WITHOUT_VERIFIED_CHAT");
    });
  });

  describe("no send with a draft present", () => {
    it("refuses and leaves the draft alone", async () => {
      const h = harness({ isDraftPresent: () => true });
      const result = await h.service.communicate({ job: job() });

      expect(result.kind).toBe("refused");
      expect(h.runnerCalls).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });

    it("logs the draft invariant violation", async () => {
      const h = harness({ isDraftPresent: () => true });
      await h.service.communicate({ job: job() });
      const violation = h.rec.criticalEvents().find((e) => e.event === "error.invariant_violation");
      expect(violation?.data?.["invariant"]).toBe("NO_SEND_WITH_DRAFT_PRESENT");
    });
  });

  describe("no send without queue ownership", () => {
    it("refuses when another tab owns the queue", async () => {
      const h = harness({
        baseGateInput: () => ({
          mode: "assist",
          humanVerificationActive: false,
          storage: { healthy: true },
          isQueueOwner: false,
          sessionLimitReached: false,
          hourlyLimitReached: false,
          rateLimited: false,
        }),
      });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("refused");
      expect(h.runnerCalls).toHaveLength(0);
    });
  });

  describe("no automatic action during human verification", () => {
    it("refuses and tells the operator what to do", async () => {
      const h = harness({
        baseGateInput: () => ({
          mode: "assist",
          humanVerificationActive: true,
          storage: { healthy: true },
          isQueueOwner: true,
          sessionLimitReached: false,
          hourlyLimitReached: false,
          rateLimited: false,
        }),
      });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.message).toContain("manual verification");
        expect(result.message).toContain("re-check");
      }
      expect(h.runnerCalls).toHaveLength(0);
    });
  });

  describe("mode gating", () => {
    it("refuses in manual mode", async () => {
      const h = harness({
        baseGateInput: () => ({
          mode: "manual",
          humanVerificationActive: false,
          storage: { healthy: true },
          isQueueOwner: true,
          sessionLimitReached: false,
          hourlyLimitReached: false,
          rateLimited: false,
        }),
      });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("refused");
      expect(h.runnerCalls).toHaveLength(0);
    });
  });

  describe("no second send after an attempt", () => {
    it("refuses to resend when a click was already dispatched", async () => {
      const alreadyClicked: CommunicationIntent = {
        ...createIntent({
          id: "txn-old",
          jobId: asJobId("job-1"),
          sourceUrl: "u",
          messageText: "m",
          outgoingBaseline: 0,
          now: NOW,
          ttlMs: 1_000,
        }),
        phase: "send-attempted",
        sendAttemptedAt: NOW,
        clickDispatched: NOW + 1,
      };

      const h = harness({ readPersistedIntent: () => alreadyClicked });
      const result = await h.service.communicate({ job: job() });

      // Uncertain, never a resend: a message may already have gone out.
      expect(result.kind).toBe("uncertain");
      expect(h.runnerCalls).toHaveLength(0);
    });

    it("does not treat a merely-armed intent as an attempt", async () => {
      const armed: CommunicationIntent = createIntent({
        id: "txn-old",
        jobId: asJobId("job-1"),
        sourceUrl: "u",
        messageText: "m",
        outgoingBaseline: 0,
        now: NOW,
        ttlMs: 1_000,
      });
      expect(hasSendBeenAttempted(armed)).toBe(false);
      expect(hasSendBeenAttempted(markClickDispatched(armed, NOW))).toBe(true);
    });
  });

  describe("message resolution", () => {
    it("refuses when no template is configured rather than sending nothing", async () => {
      const h = harness({ templates: () => [] });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("refused");
      expect(result.kind === "refused" ? result.reason : "").toBe("no-template");
      expect(h.runnerCalls).toHaveLength(0);
    });

    it("refuses a template whose variable cannot be resolved", async () => {
      const h = harness({
        templates: () => [
          createTemplate({ id: "bad", name: "Bad", content: "{{recruiter}}您好", isDefault: true }),
        ],
      });
      const noRecruiter = job({ recruiters: [] });
      const result = await h.service.communicate({ job: noRecruiter });

      expect(result.kind).toBe("refused");
      expect(result.kind === "refused" ? result.reason : "").toBe("template-invalid");
      expect(h.runnerCalls).toHaveLength(0);
    });
  });

  describe("runner outcomes are translated honestly", () => {
    it("passes through uncertain without retrying", async () => {
      const h = harness({
        runner: {
          run: async () => ({ kind: "uncertain", detail: "no outgoing message observed" }),
        },
      });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("uncertain");
    });

    it("passes through blocked", async () => {
      const h = harness({
        runner: {
          run: async () => ({ kind: "blocked", reason: "captcha", evidence: "verification page" }),
        },
      });
      const result = await h.service.communicate({ job: job() });
      expect(result.kind).toBe("blocked");
    });

    it("treats a runner exception as uncertain, never as a retryable failure", async () => {
      const h = harness({
        runner: {
          run: async () => {
            throw new Error("DOM exploded mid-send");
          },
        },
      });
      const result = await h.service.communicate({ job: job() });
      // An exception leaves the outcome unknown, so it must not look retryable.
      expect(result.kind).toBe("uncertain");
    });
  });

  describe("gate ordering", () => {
    it("checks the cheapest safety gates before touching the runner", async () => {
      const spy = vi.fn(() => ({ verified: true, detail: "ok" }));
      const h = harness({
        verifyChat: spy,
        baseGateInput: () => ({
          mode: "manual",
          humanVerificationActive: false,
          storage: { healthy: true },
          isQueueOwner: true,
          sessionLimitReached: false,
          hourlyLimitReached: false,
          rateLimited: false,
        }),
      });

      await h.service.communicate({ job: job() });
      // Mode is the first gate, so the chat verification must not have run.
      expect(spy).not.toHaveBeenCalled();
    });

    it("records which gate blocked, for triage", async () => {
      const h = harness({
        baseGateInput: () => ({
          mode: "assist",
          humanVerificationActive: false,
          storage: { healthy: true },
          isQueueOwner: false,
          sessionLimitReached: false,
          hourlyLimitReached: false,
          rateLimited: false,
        }),
      });
      await h.service.communicate({ job: job() });
      const gate = h.rec.events().find((event) => event.event === "gate.blocked");
      expect(gate?.data?.["reason"]).toBe("not-owner");
    });
  });
});
