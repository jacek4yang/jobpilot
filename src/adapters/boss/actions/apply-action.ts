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

import type { JobDetail, JobSummary } from "../../../domain/job/job";
import { asJobId } from "../../../domain/support/ids";
import type { Clock } from "../../../domain/support/shared";
import type {
  ApplyOptions,
  ApplyResult,
  BlockReason,
  VerificationResult,
} from "../../../ports/job-platform";
import type { Logger } from "../../../ports/logger";
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
 * Reports whether an element is actually perceivable to the user.
 *
 * `querySelector` happily matches `hidden`, `display:none` and
 * `aria-hidden="true"` nodes, and real sites routinely keep confirmation
 * banners in the DOM but hidden. Treating a hidden marker as evidence would
 * manufacture a false `submitted` / `already-applied`, so hidden nodes are
 * rejected outright.
 *
 * Failure mode: returns `false` when visibility cannot be established, which
 * downgrades the outcome to `needs-confirmation` — the safe direction.
 */
const isVisible = (element: Element): boolean => {
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;

  // Duck-typed rather than `instanceof HTMLElement`, which is not guaranteed to
  // exist in non-browser test environments.
  const inlineStyle = element.getAttribute("style");
  if (inlineStyle !== null) {
    const normalized = inlineStyle.replace(/\s+/g, "").toLowerCase();
    if (normalized.includes("display:none") || normalized.includes("visibility:hidden")) {
      return false;
    }
  }
  return true;
};

/**
 * Finds the first VISIBLE match for an entry.
 *
 * Returns `null` when every candidate either misses or resolves only to hidden
 * nodes. This is deliberately not `queryFirst`: evidence must be something the
 * user could actually have seen.
 */
const queryVisible = (
  root: ParentNode,
  entry: (typeof SELECTORS)["detail"][keyof (typeof SELECTORS)["detail"]],
): { readonly element: Element; readonly matchedBy: string } | null => {
  for (const candidate of entry.candidates) {
    let matches: readonly Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(candidate));
    } catch {
      continue;
    }
    const visible = matches.find((match) => isVisible(match));
    if (visible !== undefined) return { element: visible, matchedBy: candidate };
  }
  return null;
};

/**
 * Inspects the DOM for post-click confirmation.
 *
 * Only *visible* markers count. Failure mode: returns `{ kind: "none" }` when
 * nothing conclusive and visible is present. "none" is NOT success — the caller
 * maps it to `needs-confirmation`.
 */
export const readApplyEvidence = (root: ParentNode): ApplyEvidence => {
  const success = queryVisible(root, SELECTORS.detail.applySuccessMarker);
  if (success !== null) {
    return { kind: "success", evidence: `visible match on ${success.matchedBy}` };
  }

  const already = queryVisible(root, SELECTORS.detail.alreadyAppliedMarker);
  if (already !== null) {
    return { kind: "already-applied", evidence: `visible match on ${already.matchedBy}` };
  }

  const dialog = queryVisible(root, SELECTORS.detail.applyDialog);
  if (dialog !== null) {
    return { kind: "dialog", evidence: `visible match on ${dialog.matchedBy}` };
  }

  return { kind: "none", evidence: "no visible confirmation marker matched" };
};

/**
 * Reports whether an element can actually be clicked.
 *
 * Checks for a callable `click` property rather than using `instanceof`, so the
 * probe works across realms and in non-browser test environments.
 *
 * Failure mode: returns `false` for anything without a callable `click`, which
 * blocks the attempt rather than throwing mid-action.
 */
const hasClickMethod = (element: Element): element is Element & { click: () => void } =>
  typeof (element as { click?: unknown }).click === "function";

/** Reads the button's current label, used only for evidence text. */
const describeButton = (element: Element): string => {
  const label = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const classes = element.getAttribute("class") ?? "";
  const disabled = element.hasAttribute("disabled") ? " disabled" : "";
  return `label="${label}" class="${classes}"${disabled}`;
};

/** The one acceptable visible label for the detail-pane apply control. */
const COMMUNICATE_LABEL = "立即沟通";

/**
 * Normalises whitespace the same way the communication readers do, so the
 * label comparison is layout-insensitive. Mirrors `findSendButton`: a
 * non-empty aria-label wins, otherwise the *entire* textContent is used.
 */
const normalisedLabel = (element: Element): string => {
  const aria = (element.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
  if (aria.length > 0) return aria;
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
};

/**
 * Reports whether the element is the detail-pane 立即沟通 control, in the same
 * style as the send-button label filter (`chat-reader.findSendButton`): the
 * aria-label wins when present, otherwise the *entire* normalised textContent
 * must equal 立即沟通 exactly. A substring match is rejected — the 2026-09-21
 * capture shows the drawer's action block also contains an `a.op-btn-like`
 * labelled 收藏, and any control whose label is not exactly 立即沟通 must never
 * be clicked.
 *
 * Failure mode: `false` for anything else; the caller blocks rather than
 * clicking an unidentified control.
 */
const hasCommunicateLabel = (element: Element): boolean =>
  normalisedLabel(element) === COMMUNICATE_LABEL;

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

      // Exact-label check, same discipline as the send-button filter in
      // chat-reader: the 2026-09-21 capture shows this control is an
      // `<a class="op-btn op-btn-chat">立即沟通</a>` whose action block also
      // contains an `a.op-btn-like` (收藏). A matched node whose ENTIRE
      // normalised label is not exactly 立即沟通 is NOT the apply control, so
      // the attempt blocks here rather than clicking an unidentified node.
      if (!hasCommunicateLabel(located.element)) {
        return blocked(
          job,
          "selector-missing",
          `no candidate matched for applyButton with the exact label ${COMMUNICATE_LABEL} (${describeButton(located.element)})`,
        );
      }

      if (looksDisabled(located.element)) {
        return blocked(
          job,
          "ambiguous-state",
          `apply control disabled (${describeButton(located.element)})`,
        );
      }

      // An already-applied badge means there is nothing to do; this is a safe
      // terminal state, not a failure. Only a VISIBLE badge counts: hidden
      // badges are commonly pre-rendered and must not suppress a real apply.
      const preExisting = queryVisible(root, SELECTORS.detail.alreadyAppliedMarker);
      if (preExisting !== null) {
        return {
          outcome: {
            kind: "already-applied",
            evidence: `pre-existing marker matched ${preExisting.matchedBy}`,
          },
          jobId: jobIdOf(job),
        };
      }

      // Duck-typed clickability probe. `instanceof HTMLElement` is avoided
      // because the global constructor is not guaranteed to exist outside a
      // browser realm (and cross-realm nodes would fail the check anyway).
      if (!hasClickMethod(located.element)) {
        return blocked(job, "ambiguous-state", "apply control exposes no click() method");
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
        default:
          // Includes the explicit "none" case: no marker matched at all.
          return {
            outcome: {
              kind: "needs-confirmation",
              evidence:
                "click dispatched but no confirmation marker appeared; outcome is unverified",
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

      // The apply control is still present, labelled exactly 立即沟通 and
      // enabled => the posting is probably still un-applied. This is a
      // *positive* not-applied signal; a control with any other label is not
      // trusted as evidence either way.
      const button = queryFirst(root, SELECTORS.detail.applyButton);
      if (
        button !== null &&
        hasCommunicateLabel(button.element) &&
        !looksDisabled(button.element)
      ) {
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
              : hasCommunicateLabel(button.element)
                ? "apply control present but disabled with no confirmation marker"
                : `apply control present but its label is not exactly ${COMMUNICATE_LABEL}, so it is not trusted as apply evidence`,
        },
        jobId: jobIdOf(job),
      };
    },
  };
};
