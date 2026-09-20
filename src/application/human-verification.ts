/**
 * Human verification.
 *
 * When BOSS presents a challenge — CAPTCHA, security verification, identity
 * verification, login wall, or an operation-too-frequent warning — JobPilot
 * stops and hands control to the user. It never interacts with the challenge.
 *
 * This file owns the two-step recovery, which is deliberately not automatic:
 *
 *   user completes the challenge in the BOSS UI
 *     -> user presses "Re-check page"
 *          -> JobPilot validates the page is genuinely safe again
 *     -> UI shows "Ready to resume"
 *     -> user explicitly presses Resume
 *
 * The challenge disappearing is never sufficient. A page can be mid-transition,
 * or a different challenge can have replaced the first one, and resuming into
 * either would mean acting on a page we have not validated.
 */

import { EVENTS } from "../diagnostics/event";
import type { DiagnosticRecorder } from "../diagnostics/recorder";
import type { PageKind } from "../ports/job-platform";

/** Why JobPilot is waiting for a human. */
export type VerificationKind =
  | "captcha"
  | "security-verification"
  | "identity-verification"
  | "login-required"
  | "risk-control"
  | "too-frequent"
  | "unknown-modal";

export const VERIFICATION_EVENT: Readonly<Record<VerificationKind, string>> = {
  captcha: EVENTS.captchaDetected,
  "security-verification": EVENTS.securityVerificationDetected,
  "identity-verification": EVENTS.securityVerificationDetected,
  "login-required": EVENTS.loginDetected,
  "risk-control": EVENTS.riskControlDetected,
  "too-frequent": EVENTS.tooFrequentDetected,
  "unknown-modal": EVENTS.unknownModalDetected,
};

/** Operator-facing explanation. Plain language, and it says what to do. */
export const VERIFICATION_MESSAGE: Readonly<Record<VerificationKind, string>> = {
  captcha: "BOSS is showing a CAPTCHA. Complete it in the page.",
  "security-verification": "BOSS is asking for a security check. Complete it in the page.",
  "identity-verification": "BOSS is asking you to verify your identity. Complete it in the page.",
  "login-required": "Your BOSS session has expired. Sign in again in the page.",
  "risk-control": "BOSS has shown a risk warning. Resolve it in the page.",
  "too-frequent": "BOSS says operations are too frequent. Wait, then re-check.",
  "unknown-modal":
    "BOSS is showing a dialog JobPilot does not recognise. Handle it, then re-check.",
};

export type VerificationPhase =
  /** No challenge is present. */
  | "clear"
  /** A challenge is present; the user has not acted yet. */
  | "blocked"
  /** The user asked us to re-check, and the page looks safe. */
  | "ready"
  /** The user asked us to re-check, and a challenge is still present. */
  | "still-blocked";

export interface VerificationState {
  readonly phase: VerificationPhase;
  readonly kind?: VerificationKind;
  /** Set when a re-check found the page unsafe. */
  readonly lastCheckDetail?: string;
  readonly since: number;
}

export const initialVerificationState = (now: number): VerificationState => ({
  phase: "clear",
  since: now,
});

/** Conditions the page must satisfy before a re-check can pass. */
export interface RecheckInput {
  readonly pageKind: PageKind;
  readonly loginValid: boolean;
  readonly riskPresent: boolean;
  readonly expectedRoute: boolean;
  readonly storageHealthy: boolean;
  readonly isQueueOwner: boolean;
}

export interface RecheckResult {
  readonly ok: boolean;
  /** Every failed condition, so the UI can say exactly what is still wrong. */
  readonly failures: readonly string[];
  readonly detail: string;
}

/**
 * Validates that the page is safe to resume on.
 *
 * Checks every condition rather than the first failure: an operator who fixes
 * one problem only to be told about the next would rightly lose patience with
 * the tool.
 */
export const recheckPage = (input: RecheckInput): RecheckResult => {
  const failures: string[] = [];

  if (input.pageKind === "captcha") failures.push("a CAPTCHA is still on screen");
  if (input.pageKind === "login-required" || !input.loginValid) {
    failures.push("you are not signed in");
  }
  if (input.riskPresent) failures.push("a risk warning is still on screen");
  if (input.pageKind === "unknown" || input.pageKind === "unsupported") {
    failures.push("JobPilot does not recognise this page");
  }
  if (!input.expectedRoute) failures.push("the page is not on the expected route");
  if (!input.storageHealthy) failures.push("local storage is unavailable");
  if (!input.isQueueOwner) failures.push("another tab owns the queue");

  if (failures.length === 0) {
    return { ok: true, failures, detail: "The page looks safe to resume." };
  }
  return {
    ok: false,
    failures,
    detail: `JobPilot cannot resume yet: ${failures.join("; ")}.`,
  };
};

export interface VerificationController {
  state(): VerificationState;
  /**
   * Enters the blocked state. Idempotent: a second detection of the same kind
   * does not reset the timer, so the UI does not flicker.
   */
  block(kind: VerificationKind, now: number): VerificationState;
  /** Runs the re-check and moves to `ready` or `still-blocked`. */
  recheck(
    input: RecheckInput,
    now: number,
  ): { readonly state: VerificationState; readonly result: RecheckResult };
  /** Clears the state. Only called after an explicit user Resume. */
  clear(now: number): VerificationState;
  /** True while any automated action must be refused. */
  isBlocked(): boolean;
}

export const createVerificationController = (
  recorder: DiagnosticRecorder,
  now: () => number = () => Date.now(),
): VerificationController => {
  let state: VerificationState = initialVerificationState(now());

  const record = (event: string, data?: Readonly<Record<string, unknown>>): void => {
    recorder.record({
      level: "warn",
      category: "risk",
      event,
      ...(data === undefined ? {} : { data: data as never }),
    });
  };

  return {
    state: () => state,

    block(kind, at) {
      if (state.phase === "blocked" && state.kind === kind) return state;
      state = { phase: "blocked", kind, since: at };
      record(VERIFICATION_EVENT[kind], {
        kind,
        // Recorded so the bundle shows what was detected, not just that
        // something was.
        message: VERIFICATION_MESSAGE[kind],
      });
      return state;
    },

    recheck(input, at) {
      const result = recheckPage(input);
      state = {
        phase: result.ok ? "ready" : "still-blocked",
        ...(state.kind === undefined ? {} : { kind: state.kind }),
        since: at,
        lastCheckDetail: result.detail,
      };
      record(EVENTS.humanVerificationRecheck, {
        ok: result.ok,
        failures: [...result.failures],
      });
      return { state, result };
    },

    clear(at) {
      state = initialVerificationState(at);
      record(EVENTS.humanVerificationResolved, { resumedAt: at });
      return state;
    },

    isBlocked: () => state.phase !== "clear",
  };
};
