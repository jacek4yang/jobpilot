import { describe, expect, it } from "vitest";
import {
  createVerificationController,
  initialVerificationState,
  type RecheckInput,
  recheckPage,
  VERIFICATION_EVENT,
  VERIFICATION_MESSAGE,
  type VerificationKind,
} from "../../../src/application/human-verification";
import { createDiagnosticRecorder } from "../../../src/diagnostics/recorder";

const NOW = 1_700_000_000_000;

const recorder = () =>
  createDiagnosticRecorder({
    now: () => NOW,
    monotonicNow: () => 0,
    capacity: 200,
    minLevel: "trace",
  });

const safePage: RecheckInput = {
  pageKind: "job-list",
  loginValid: true,
  riskPresent: false,
  expectedRoute: true,
  storageHealthy: true,
  isQueueOwner: true,
};

describe("human verification", () => {
  describe("detection", () => {
    const kinds: readonly VerificationKind[] = [
      "captcha",
      "security-verification",
      "identity-verification",
      "login-required",
      "risk-control",
      "too-frequent",
      "unknown-modal",
    ];

    for (const kind of kinds) {
      it(`blocks on ${kind}`, () => {
        const rec = recorder();
        const controller = createVerificationController(rec, () => NOW);
        const state = controller.block(kind, NOW);

        expect(state.phase).toBe("blocked");
        expect(state.kind).toBe(kind);
        expect(controller.isBlocked()).toBe(true);
        // Every kind must be recorded, or a bundle cannot explain the stop.
        expect(rec.criticalEvents().some((event) => event.event === VERIFICATION_EVENT[kind])).toBe(
          true,
        );
      });

      it(`has an operator-facing message for ${kind}`, () => {
        // A user who cannot tell what to do will guess, and guessing is what
        // the safety model exists to prevent.
        expect(VERIFICATION_MESSAGE[kind].length).toBeGreaterThan(0);
      });
    }

    it("is idempotent for the same challenge", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      const second = controller.block("captcha", NOW + 5_000);
      // The timer must not reset, or the UI would flicker on every re-detect.
      expect(second.since).toBe(NOW);
    });

    it("updates the kind when a different challenge appears", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      const second = controller.block("login-required", NOW + 1_000);
      expect(second.kind).toBe("login-required");
    });
  });

  describe("blocking is absolute", () => {
    it("starts clear", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      expect(initialVerificationState(NOW).phase).toBe("clear");
      expect(controller.isBlocked()).toBe(false);
    });

    it("refuses automation while blocked", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      expect(controller.isBlocked()).toBe(true);
    });

    it("stays blocked after a failed re-check", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      const { state } = controller.recheck({ ...safePage, pageKind: "captcha" }, NOW + 1_000);
      expect(state.phase).toBe("still-blocked");
      // Still refusing: "still blocked" is not "clear".
      expect(controller.isBlocked()).toBe(true);
    });
  });

  describe("re-check validation", () => {
    it("passes when every condition holds", () => {
      const result = recheckPage(safePage);
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it("fails while a CAPTCHA is still on screen", () => {
      const result = recheckPage({ ...safePage, pageKind: "captcha" });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("CAPTCHA");
    });

    it("fails while signed out, even if the page kind looks fine", () => {
      // A route can render before the session is restored, so page kind alone
      // is not sufficient evidence.
      const result = recheckPage({ ...safePage, loginValid: false });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("signed in");
    });

    it("fails while a risk warning remains", () => {
      const result = recheckPage({ ...safePage, riskPresent: true });
      expect(result.ok).toBe(false);
    });

    it("fails on an unrecognised page", () => {
      expect(recheckPage({ ...safePage, pageKind: "unknown" }).ok).toBe(false);
      expect(recheckPage({ ...safePage, pageKind: "unsupported" }).ok).toBe(false);
    });

    it("fails on the wrong route", () => {
      const result = recheckPage({ ...safePage, expectedRoute: false });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("expected route");
    });

    it("fails while storage is unhealthy", () => {
      const result = recheckPage({ ...safePage, storageHealthy: false });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("storage");
    });

    it("fails when another tab owns the queue", () => {
      const result = recheckPage({ ...safePage, isQueueOwner: false });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("another tab");
    });

    it("reports every failed condition, not just the first", () => {
      // Otherwise the operator fixes one problem and is told about the next.
      const result = recheckPage({
        pageKind: "captcha",
        loginValid: false,
        riskPresent: true,
        expectedRoute: false,
        storageHealthy: false,
        isQueueOwner: false,
      });
      expect(result.failures.length).toBeGreaterThan(3);
    });
  });

  describe("two-step recovery", () => {
    it("moves to ready after a successful re-check but stays blocked for automation", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      const { state, result } = controller.recheck(safePage, NOW + 2_000);

      expect(result.ok).toBe(true);
      expect(state.phase).toBe("ready");
      // `ready` is not resumed: the user still has to press Resume, so
      // automation must remain refused.
      expect(controller.isBlocked()).toBe(true);
    });

    it("only clears on an explicit resume", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      controller.recheck(safePage, NOW + 1_000);
      expect(controller.isBlocked()).toBe(true);

      controller.clear(NOW + 3_000);
      expect(controller.isBlocked()).toBe(false);
      expect(controller.state().phase).toBe("clear");
    });

    it("records both the re-check and the resolution", () => {
      const rec = recorder();
      const controller = createVerificationController(rec, () => NOW);
      controller.block("captcha", NOW);
      controller.recheck(safePage, NOW + 1_000);
      controller.clear(NOW + 2_000);

      const events = rec.events().map((event) => event.event);
      expect(events).toContain("risk.human_verification.recheck");
      expect(events).toContain("risk.human_verification.resolved");
    });

    it("does not clear merely because the challenge disappeared", () => {
      // The core guarantee. Reaching `ready` is not resuming.
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      controller.recheck(safePage, NOW + 1_000);

      // No clear() call: the state must still refuse automation.
      expect(controller.state().phase).toBe("ready");
      expect(controller.isBlocked()).toBe(true);
    });

    it("returns to blocked if a challenge reappears after being ready", () => {
      const controller = createVerificationController(recorder(), () => NOW);
      controller.block("captcha", NOW);
      controller.recheck(safePage, NOW + 1_000);
      controller.block("captcha", NOW + 2_000);
      expect(controller.state().phase).toBe("blocked");
    });
  });
});
