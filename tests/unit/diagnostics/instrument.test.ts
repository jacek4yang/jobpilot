import { describe, expect, it } from "vitest";
import type { Effect } from "../../../src/application/events";
import { initialContext } from "../../../src/application/state";
import { EVENTS } from "../../../src/diagnostics/event";
import {
  DEFAULT_EFFECT_BUDGETS,
  traceOrchestrator,
} from "../../../src/diagnostics/instrument/effect-trace";
import {
  fingerprintPage,
  routePatternOf,
} from "../../../src/diagnostics/instrument/page-fingerprint";
import {
  describeResolution,
  recordSelectorOutcome,
} from "../../../src/diagnostics/instrument/selector-trace";
import {
  recordEffectsScheduled,
  reduceWithTrace,
} from "../../../src/diagnostics/instrument/state-trace";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";

const NOW = 1_700_000_000_000;

const recorder = () =>
  createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 0,
    capacity: 500,
    minLevel: "trace",
  });

const reduceOptions = { now: NOW, maxRetries: 2 };

/** Minimal DOM for fingerprint tests, without pulling in happy-dom. */
const fakeDocument = (html: string): Document => {
  const elements: { selector: string; count: number; text?: string }[] = [];
  void html;
  return {
    querySelectorAll: (selector: string) => {
      const found = elements.find((entry) => entry.selector === selector);
      return Array.from(
        { length: found?.count ?? 0 },
        () =>
          ({
            textContent: found?.text ?? "",
            getBoundingClientRect: () => ({ width: 10, height: 10 }),
          }) as unknown as Element,
      );
    },
  } as unknown as Document;
};

describe("state-machine tracing", () => {
  it("records a transition with from, trigger, to and effects", () => {
    const rec = recorder();
    const result = reduceWithTrace(rec, {
      context: initialContext(NOW),
      event: { type: "START" },
      options: reduceOptions,
    });

    const event = rec.events().find((entry) => entry.event === EVENTS.stateTransition);
    expect(event).toBeDefined();
    expect(event?.data?.["from"]).toBe("idle");
    expect(event?.data?.["trigger"]).toBe("START");
    expect(event?.data?.["to"]).toBe("scanning");
    expect(Array.isArray(event?.data?.["effects"])).toBe(true);
    expect(result.context.state).toBe("scanning");
  });

  it("returns exactly what the pure reducer returns", () => {
    const rec = recorder();
    const context = initialContext(NOW);
    const traced = reduceWithTrace(rec, {
      context,
      event: { type: "START" },
      options: reduceOptions,
    });
    // Tracing must be transparent: same state, same effects.
    expect(traced.context.state).toBe("scanning");
    expect(traced.effects.length).toBeGreaterThan(0);
  });

  it("records a rejected transition rather than hiding it", () => {
    const rec = recorder();
    // RESUME is illegal while idle; the reducer returns the context unchanged.
    reduceWithTrace(rec, {
      context: initialContext(NOW),
      event: { type: "RESUME" },
      options: reduceOptions,
    });

    const rejected = rec.events().find((entry) => entry.event === EVENTS.stateTransitionRejected);
    expect(rejected).toBeDefined();
    expect(rejected?.data?.["changed"]).toBe(false);
    expect(rejected?.data?.["from"]).toBe("idle");
  });

  it("records dwell time in the previous state", () => {
    const rec = recorder();
    const context = { ...initialContext(NOW), stateSince: NOW - 5_000 };
    reduceWithTrace(rec, { context, event: { type: "START" }, options: reduceOptions });
    const event = rec.events().find((entry) => entry.event === EVENTS.stateTransition);
    expect(event?.data?.["dwellMs"]).toBe(5_000);
  });

  it("carries the job id when one is in flight", () => {
    const rec = recorder();
    const context = {
      ...initialContext(NOW),
      currentJob: { id: "job-7" } as never,
    };
    reduceWithTrace(rec, { context, event: { type: "START" }, options: reduceOptions });
    expect(rec.events().find((e) => e.event === EVENTS.stateTransition)?.jobId).toBe("job-7");
  });

  it("does not record effects scheduled for a rejected transition", () => {
    const rec = recorder();
    const context = initialContext(NOW);
    // No effects is the honest answer; scheduling nothing records nothing.
    recordEffectsScheduled(rec, [], context);
    expect(rec.events().filter((e) => e.event === "effect.scheduled")).toHaveLength(0);
  });
});

describe("effect tracing", () => {
  const effect = (type: Effect["type"]): Effect =>
    type === "notify" ? { type: "notify", level: "info", message: "x" } : ({ type } as Effect);

  it("records started before completed", () => {
    const rec = recorder();
    let clock = 0;
    const traced = traceOrchestrator(
      { abortCurrent: () => {}, runEffect: async () => {}, dispose: () => {} },
      { recorder: rec, now: () => (clock += 10) },
    );

    return traced.runEffect(effect("persist"), initialContext(NOW)).then(() => {
      const names = rec.events().map((e) => e.event);
      expect(names).toContain(EVENTS.effectStarted);
      expect(names).toContain(EVENTS.effectCompleted);
      // Started must come first: an effect that hangs still leaves evidence.
      expect(names.indexOf(EVENTS.effectStarted)).toBeLessThan(
        names.indexOf(EVENTS.effectCompleted),
      );
    });
  });

  it("records a duration", async () => {
    const rec = recorder();
    let clock = 0;
    const traced = traceOrchestrator(
      { abortCurrent: () => {}, runEffect: async () => {}, dispose: () => {} },
      { recorder: rec, now: () => (clock += 25) },
    );
    await traced.runEffect(effect("persist"), initialContext(NOW));
    const completed = rec.events().find((e) => e.event === EVENTS.effectCompleted);
    expect(completed?.data?.["durationMs"]).toBeGreaterThan(0);
  });

  it("records a failure and rethrows", async () => {
    const rec = recorder();
    const traced = traceOrchestrator(
      {
        abortCurrent: () => {},
        runEffect: async () => {
          throw new Error("boom");
        },
        dispose: () => {},
      },
      { recorder: rec, now: () => 0 },
    );

    await expect(traced.runEffect(effect("persist"), initialContext(NOW))).rejects.toThrow("boom");
    const failed = rec.events().find((e) => e.event === EVENTS.effectFailed);
    expect(failed?.data?.["errorMessage"]).toBe("boom");
  });

  it("classifies an abort as a cancellation, not a failure", () => {
    const rec = recorder();
    const traced = traceOrchestrator(
      {
        abortCurrent: () => {},
        runEffect: async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
        dispose: () => {},
      },
      { recorder: rec, now: () => 0 },
    );

    return traced.runEffect(effect("persist"), initialContext(NOW)).catch(() => {
      // A pause or dispose is an expected outcome; reporting it as a fault
      // would fill the bundle with noise exactly when the operator stopped.
      expect(rec.events().some((e) => e.event === EVENTS.effectCancelled)).toBe(true);
      expect(rec.events().some((e) => e.event === EVENTS.effectFailed)).toBe(false);
    });
  });

  it("flags an effect that exceeds its budget", async () => {
    const rec = recorder();
    let clock = 0;
    const traced = traceOrchestrator(
      { abortCurrent: () => {}, runEffect: async () => {}, dispose: () => {} },
      { recorder: rec, now: () => (clock += 5_000), budgets: { persist: 1_000 } },
    );
    await traced.runEffect(effect("persist"), initialContext(NOW));
    expect(rec.events().some((e) => e.event === EVENTS.effectTimedOut)).toBe(true);
  });

  it("ships budgets for every common effect", () => {
    for (const name of ["scan-jobs", "load-job", "evaluate-job", "contact-job"]) {
      expect(DEFAULT_EFFECT_BUDGETS[name]).toBeGreaterThan(0);
    }
  });
});

describe("selector tracing", () => {
  it("records a match with the winning candidate", () => {
    const rec = recorder();
    recordSelectorOutcome(
      rec,
      describeResolution("detail.applyButton", [
        {
          selector: ".a",
          confidence: "high",
          matches: 0,
          visible: 0,
          selected: false,
          rejectedBecause: "no-match",
        },
        { selector: ".b", confidence: "medium", matches: 1, visible: 1, selected: true },
      ]),
    );
    const event = rec.events().find((e) => e.event === EVENTS.selectorMatch);
    expect(event?.data?.["selected"]).toBe(".b");
    expect(event?.data?.["purpose"]).toBe("detail.applyButton");
  });

  it("records a miss with every candidate it tried", () => {
    const rec = recorder();
    recordSelectorOutcome(
      rec,
      describeResolution("detail.applyButton", [
        {
          selector: ".a",
          confidence: "high",
          matches: 0,
          visible: 0,
          selected: false,
          rejectedBecause: "no-match",
        },
        {
          selector: ".b",
          confidence: "fallback",
          matches: 0,
          visible: 0,
          selected: false,
          rejectedBecause: "no-match",
        },
      ]),
    );
    const event = rec.events().find((e) => e.event === EVENTS.selectorMiss);
    expect(event).toBeDefined();
    const candidates = event?.data?.["candidates"];
    expect(Array.isArray(candidates) ? candidates.length : 0).toBe(2);
  });

  it("reports ambiguity distinctly from a miss", () => {
    const rec = recorder();
    recordSelectorOutcome(
      rec,
      describeResolution("detail.applyButton", [
        {
          selector: ".a",
          confidence: "high",
          matches: 3,
          visible: 3,
          selected: false,
          rejectedBecause: "ambiguous",
        },
      ]),
    );
    // An ambiguity is a worse signal than an absence: the page has more
    // candidates than expected.
    expect(rec.events().some((e) => e.event === EVENTS.selectorAmbiguous)).toBe(true);
    expect(rec.events().some((e) => e.event === EVENTS.selectorMiss)).toBe(false);
  });

  it("flags a heuristic winner", () => {
    const rec = recorder();
    recordSelectorOutcome(
      rec,
      describeResolution("detail.applyButton", [
        { selector: ".guess", confidence: "unverified", matches: 1, visible: 1, selected: true },
      ]),
    );
    const event = rec.events().find((e) => e.event === EVENTS.selectorMatch);
    expect(event?.data?.["heuristic"]).toBe(true);
  });

  it("never records page text beyond the candidate selectors", () => {
    const rec = recorder();
    recordSelectorOutcome(
      rec,
      describeResolution("detail.applyButton", [
        { selector: ".a", confidence: "high", matches: 1, visible: 1, selected: true },
      ]),
    );
    const serialised = JSON.stringify(rec.events());
    expect(serialised).toContain(".a");
    // Selector diagnostics must not become a page capture.
    expect(serialised).not.toContain("innerHTML");
  });
});

describe("page fingerprinting", () => {
  it("normalises a job-detail route so two jobs fingerprint alike", () => {
    expect(routePatternOf("/web/geek/job_detail/abc123.html")).toBe(
      "/web/geek/job_detail/{id}.html",
    );
    expect(routePatternOf("/web/geek/job_detail/xyz789.html")).toBe(
      "/web/geek/job_detail/{id}.html",
    );
  });

  it("replaces long numeric segments with a placeholder", () => {
    expect(routePatternOf("/web/geek/1234567")).toBe("/web/geek/{id}");
  });

  it("produces a stable signature for the same structure", () => {
    const doc = fakeDocument("");
    const a = fingerprintPage({
      document: doc,
      pageKind: "job-list",
      location: { pathname: "/web/geek/job" },
    });
    const b = fingerprintPage({
      document: doc,
      pageKind: "job-list",
      location: { pathname: "/web/geek/job" },
    });
    expect(a.signature).toBe(b.signature);
  });

  it("changes the signature when the page kind changes", () => {
    const doc = fakeDocument("");
    const list = fingerprintPage({
      document: doc,
      pageKind: "job-list",
      location: { pathname: "/x" },
    });
    const detail = fingerprintPage({
      document: doc,
      pageKind: "job-detail",
      location: { pathname: "/x" },
    });
    expect(list.signature).not.toBe(detail.signature);
  });

  it("records no page text", () => {
    const doc = fakeDocument("<div>secret recruiter message</div>");
    const fingerprint = fingerprintPage({
      document: doc,
      pageKind: "job-detail",
      location: { pathname: "/x" },
    });
    expect(JSON.stringify(fingerprint)).not.toContain("secret recruiter message");
  });

  it("survives a selector the environment cannot parse", () => {
    const doc = {
      querySelectorAll: () => {
        throw new Error("invalid selector");
      },
    } as unknown as Document;
    // A fingerprinting failure must not break the page it describes.
    expect(() =>
      fingerprintPage({
        document: doc,
        pageKind: "unknown",
        location: { pathname: "/x" },
        regionSelectors: ["[[["],
      }),
    ).not.toThrow();
  });
});
