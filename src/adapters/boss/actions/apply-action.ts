/**
 * BOSS Zhipin apply action.
 *
 * ============================ HONESTY NOTICE ============================
 * The real BOSS apply flow — button markup, greeting dialogs, success toasts,
 * "already applied" badges — was NEVER inspected. This module is validated only
 * against the synthetic fixture `tests/fixtures/boss/job-detail.html`. Real-site
 * application submission is UNVERIFIED and must not be relied upon.
 * =======================================================================
 *
 * Safety model (all three are non-negotiable):
 *   1. Re-check every guard BEFORE touching the DOM. A CAPTCHA, risk-control or
 *      expired-login page aborts the attempt with a typed BlockReason.
 *   2. Click only an element matched by an explicit entry in `SELECTORS`. There
 *      is no text-based fallback for the apply button. A miss is
 *      `selector-missing`, not a best guess.
 *   3. Never infer success. After clicking, the DOM is re-read for confirmation
 *      evidence. Absent or ambiguous evidence yields `needs-confirmation` — the
 *      single most important rule in this file.
 */

import type {
  ApplyOptions,
  ApplyResult,
  BlockReason,
  VerificationResult,
} from "../../../ports/job-platform";
import type { JobDetail, JobSummary } from "../../../domain/job/job";
import type { Logger } from "../../../ports/logger";
import type { Clock } from "../../../domain/support/shared";
import { asJobId } from "../../../domain/support/ids";
import { detectCaptcha, detectLoginRequired, detectRiskControl } from "../guards";
import { queryFirst, SELECTORS } from "../selectors";
import { throwIfAborted } from "./abort";

/** Dependencies of the apply action. All injectable so tests need no browser. */
export interface ApplyActionDeps {
  /** Scope searched for guards, the apply button and confirmation evidence. */
  readonly root: ParentNode;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Optional structural page-kind probe used for one extra pre-click check. */
}

/** The apply action surface, mirroring `JobPlatform`'s apply/verify pair. */
export interface ApplyAction {
  apply(job: JobDetail, options?: ApplyOptions): Promise<ApplyResult>;
  verifyApplication(job: JobDetail, options?: ApplyOptions): Promise<VerificationResult>;
}

/**
 * Evaluates the blocking guards.
 *
 * Failure mode: returns `null` when the page is clear. Never throws, and never
 * treats an unreadable page as clear — an unknown structure still runs through
 * the remaining explicit checks in `apply`.
 */
export const blockingReason = (
  root: ParentNode,
): { readonly reason: BlockReason; readonly evidence: string } | null => {
  const captcha = detectCaptcha(root);
  if (captcha.detected) return { reason: "captcha", evidence: captcha.evidence };

  const risk = detectRiskControl(root);
  if (risk.detected) return { reason: "risk-control", evidence: risk.evidence };

  const login = detectLoginRequired(root);
  if (login.detected) return { reason: "login-expired", evidence: login.evidence };

  return null;
};

/** Confirmation evidence read back from the DOM after a click, if any. */
export type ApplyEvidenceKind = "success" | "already-applied" | "dialog" | "none";

/** What the post-click DOM inspection found, with the selector that proved it. */
interface ApplyEvidence {
  readonly kind: ApplyEvidenceKind;
  readonly evidence: string;
}

/**
 * Inspects the DOM for post-click confirmation.
 *
 * Failure mode: returns `{ kind: "none" }` when nothing conclusive is present.
 * "none" is NOT success — the caller maps it to `needs-confirmation`.
 */
export const readApplyEvidence = (root: ParentNode): ApplyEvidence => {
  const success = queryFirst(root, SELECTORS.detail.applySuccessMarker);
  if (success !== null) {
    return { kind: "success", evidence: `matched ${success.matchedBy}` };
  }

  const already = queryFirst(root, SELECTORS.detail.alreadyAppliedMarker);
  if (already !== null) {
    return { kind: "already-applied", evidence: `matched ${already.matchedBy}` };
  }

  const dialog = queryFirst(root, SELECTORS.detail.applyDialog);
  if (dialog !== null) {
    return { kind: "dialog", evidence: `matched ${dialog.matchedBy}` };
  }

  return { kind: "none", evidence: "no confirmation marker matched" };
};

/** Reads the button's current label, used only for evidence text. */
const describeButton = (element: Element): string => {
  const label = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const classes = element.getAttribute("class") ?? "";
  const disabled = element.hasAttribute("disabled") ? " disabled" : "";
  return `label="${label}" class="${classes}"${disabled}`;
};

/**
 * Reports whether the control looks permanently unavailable.
 *
 * Failure mode: `false` (i.e. "assume clickable") only ever leads to a click on
 * an element that a listed selector already matched; a genuinely disabled
 * button will simply do nothing and be reported as `needs-confirmation`.
 */
const looksDisabled = (element: Element): boolean =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

/** Narrows a summary to the id string expected by `ApplyResult`. */
const jobIdOf = (job: JobSummary): string => asJobId(job.id) as string;

/**
 * Creates the apply action.
 *
 * Failure modes, in precedence order:
 *   - aborted signal            -> rejects with the abort reason
 *   - captcha / risk / login    -> `blocked` with the matching BlockReason
 *   - apply button not found    -> `blocked` `selector-missing`
 *   - button disabled           -> `blocked` `ambiguous-state`
 *   - no confirmation evidence  -> `needs-confirmation` (NEVER `submitted`)
 *   - conclusive evidence       -> `submitted` / `already-applied`
 */
export const createApplyAction = (deps: ApplyActionDeps): ApplyAction => {
  const { root, clock, logger } = deps;

  const blocked = (job: JobDetail, reason: BlockReason, evidence: string): ApplyResult => {
    logger.warn("boss.apply", "blocked before apply", { reason, evidence, jobId: jobIdOf(job) });
    return { outcome: { kind: "blocked", reason, evidence }, jobId: jobIdOf(job) };
  };

  return {
    async apply(job: JobDetail, options?: ApplyOptions): Promise<ApplyResult> {
      throwIfAborted(options?.signal);

      // (1) Guard re-check, every single time. Never cached from page load.
      const blockedReason = blockingReason(root);
      if (blockedReason !== null) {
        return blocked(job, blockedReason.reason, blockedReason.evidence);
      }

      // (2) Locate the apply control through listed selectors only.
      const located = queryFirst(root, SELECTORS.detail.applyButton);
      if (located === null) {
        return blocked(
          job,
          "selector-missing",
          `no candidate matched for applyButton: ${SELECTORS.detail.applyButton.candidates.join(", ")}`,
        );
      }

      if (looksDisabled(located.element)) {
        return blocked(job, "ambiguous-state", `apply control disabled (${describeButton(located.element)})`);
      }

      // An already-applied badge means there is nothing to do; this is a safe
      // terminal state, not a failure.
      const preExisting = queryFirst(root, SELECTORS.detail.alreadyAppliedMarker);
      if (preExisting !== null) {
        return {
          outcome: {
            kind: "already-applied",
            evidence: `pre-existing marker matched ${preExisting.matchedBy}`,
          },
          jobId: jobIdOf(job),
        };
      }

      if (!(located.element instanceof HTMLElement)) {
        return blocked(job, "ambiguous-state", "apply control is not a clickable HTMLElement");
      }

      throwIfAborted(options?.signal);
      const clickedAt = clock.now();
      logger.info("boss.apply", "clicking apply control", {
        jobId: jobIdOf(job),
        matchedBy: located.matchedBy,
        heuristic: located.heuristic,
        clickedAt,
      });
      located.element.click();

      // (3) Never assume success. Ask the DOM what actually happened.
      const evidence = readApplyEvidence(root);
      switch (evidence.kind) {
        case "success":
          return {
            outcome: { kind: "submitted", evidence: `post-click ${evidence.evidence}` },
            jobId: jobIdOf(job),
          };
        case "already-applied":
          return {
            outcome: { kind: "already-applied", evidence: `post-click ${evidence.evidence}` },
            jobId: jobIdOf(job),
          };
        case "dialog":
          // A dialog is an unanswered question, not a submission.
          return {
            outcome: {
              kind: "needs-confirmation",
              evidence: `confirmation dialog present after click (${evidence.evidence})`,
            },
            jobId: jobIdOf(job),
          };
        case "none":
        default:
          return {
            outcome: {
              kind: "needs-confirmation",
              evidence: "click dispatched but no confirmation marker appeared; outcome is unverified",
            },
            jobId: jobIdOf(job),
          };
      }
    },

    async verifyApplication(job: JobDetail, options?: ApplyOptions): Promise<VerificationResult> {
      throwIfAborted(options?.signal);

      const guard = blockingReason(root);
      if (guard !== null) {
        return {
          outcome: { kind: "indeterminate", evidence: `verification blocked: ${guard.evidence}` },
          jobId: jobIdOf(job),
        };
      }

      const evidence = readApplyEvidence(root);
      if (evidence.kind === "success" || evidence.kind === "already-applied") {
        return {
          outcome: { kind: "confirmed", evidence: evidence.evidence },
          jobId: jobIdOf(job),
        };
      }

      // The apply control is still present and enabled => the posting is
      // probably still un-applied. This is a *positive* not-applied signal.
      const button = queryFirst(root, SELECTORS.detail.applyButton);
      if (button !== null && !looksDisabled(button.element)) {
        return {
          outcome: {
            kind: "not-applied",
            evidence: `apply control still actionable (${button.matchedBy})`,
          },
          jobId: jobIdOf(job),
        };
      }

      // Anything else — including a dialog we refuse to answer — is honestly
      // reported as indeterminate rather than guessed either way.
      return {
        outcome: {
          kind: "indeterminate",
          evidence:
            button === null
              ? "apply control absent and no confirmation marker present"
              : "apply control present but disabled with no confirmation marker",
        },
        jobId: jobIdOf(job),
      };
    },
  };
};
