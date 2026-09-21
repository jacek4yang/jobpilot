/**
 * Page fingerprinting.
 *
 * Produces a privacy-safe signature of a page so a later failure can answer one
 * question: "did the layout change, or did this run differ?"
 *
 * It is deliberately a *bounded summary*, never a capture. The whole point is
 * that a fingerprint is safe to put in a bundle that leaves the operator's
 * machine, so it records structural facts — how many job cards, whether a
 * recruiter region exists, which semantic regions are present — and never page
 * text beyond a fixed list of action labels JobPilot itself looks for.
 *
 * Two fingerprints that differ means the page is structurally different. Two
 * that match means a failure was behavioural (timing, ordering, state) rather
 * than structural, which is a genuinely different investigation.
 */
import type { PageKind } from "../../ports/job-platform";
import { EVENTS, type JsonValue } from "../event";
import type { DiagnosticRecorder } from "../recorder";

export interface PageFingerprint {
  /** Normalised route pattern, e.g. `/web/geek/job` — never a full URL. */
  readonly routePattern: string;
  readonly pageKind: PageKind;
  /** Which semantic regions are present. */
  readonly regions: readonly string[];
  readonly jobCardCount: number;
  readonly dialogCount: number;
  /** Stable structural markers, e.g. presence of a data attribute. */
  readonly markers: readonly string[];
  /** Action labels JobPilot looks for, which are UI vocabulary not user data. */
  readonly actionLabels: readonly string[];
  /**
   * A digest over the structural facts above.
   *
   * Stable across runs on the same layout and different when the layout moves,
   * which is what makes it useful for cross-session comparison.
   */
  readonly signature: string;
}

/**
 * Action labels JobPilot itself searches for.
 *
 * Recording these is safe: they are BOSS's own fixed UI vocabulary, identical
 * for every user, and knowing which of them were present is exactly what makes
 * a selector failure diagnosable.
 */
const ACTION_LABELS: readonly string[] = [
  "立即沟通",
  "继续沟通",
  "已沟通",
  "发送",
  "留在此页",
  "已向BOSS发送消息",
];

export interface FingerprintInput {
  readonly document: Document;
  readonly pageKind: PageKind;
  readonly location: { readonly pathname: string };
  /** Region selectors to test for presence, from the adapter's registry. */
  readonly regionSelectors?: readonly string[];
}

/**
 * Normalises a path into a pattern.
 *
 * Job ids and numeric segments are replaced with placeholders, so two different
 * job pages fingerprint identically — the fingerprint is about layout, not
 * which job was open.
 */
export const routePatternOf = (pathname: string): string =>
  pathname
    .replace(/\/job_detail\/[^/]+\.html/, "/job_detail/{id}.html")
    .replace(/\/\d{6,}/g, "/{id}")
    .split("?")[0] ?? pathname;

const hasVisible = (element: Element): boolean => {
  const style = globalThis.getComputedStyle?.(element);
  if (style !== undefined && (style.display === "none" || style.visibility === "hidden")) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/** FNV-1a over the structural facts, so the signature is deterministic. */
const digest = (parts: readonly string[]): string => {
  const input = parts.join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * Builds a fingerprint from the live document.
 *
 * Never throws: a fingerprinting failure must not break the page it is
 * describing, so every selector query is guarded.
 */
export const fingerprintPage = (input: FingerprintInput): PageFingerprint => {
  const { document: doc } = input;
  const safeQuery = (selector: string): readonly Element[] => {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const regions: string[] = [];
  for (const selector of input.regionSelectors ?? []) {
    const found = safeQuery(selector).filter(hasVisible);
    if (found.length > 0) regions.push(selector);
  }

  const jobCardCount = safeQuery(
    "[data-jobpilot-card], .job-card-wrapper, [class*='job-card']",
  ).length;
  const dialogCount = safeQuery("[role='dialog'], [class*='dialog'], [class*='modal']").length;

  // Structural markers: presence of the data attributes JobPilot's own fixtures
  // and adapter rely on. Their absence on a live page is a useful signal.
  const markers = [
    "[data-jobpilot-card]",
    "[data-jobpilot-list]",
    "[data-jobpilot-action]",
    "[data-jobpilot-guard]",
  ].filter((selector) => safeQuery(selector).length > 0);

  // Action labels are read from a bounded set of button-like elements, and only
  // to test for exact matches against the fixed vocabulary above.
  const actionLabels = ACTION_LABELS.filter((label) =>
    safeQuery("button, a, [role='button']").some(
      (element) => (element.textContent ?? "").trim() === label,
    ),
  );

  const routePattern = routePatternOf(input.location.pathname);

  return {
    routePattern,
    pageKind: input.pageKind,
    regions: [...regions].sort(),
    jobCardCount,
    dialogCount,
    markers: [...markers].sort(),
    actionLabels: [...actionLabels].sort(),
    signature: digest([
      routePattern,
      input.pageKind,
      String(jobCardCount),
      String(dialogCount),
      [...regions].sort().join(","),
      [...markers].sort().join(","),
      [...actionLabels].sort().join(","),
    ]),
  };
};

/** Records a fingerprint. Called on meaningful page/route changes only. */
export const recordPageFingerprint = (
  recorder: DiagnosticRecorder,
  fingerprint: PageFingerprint,
): void => {
  recorder.record({
    level: "debug",
    category: "page-detection",
    event: EVENTS.pageFingerprinted,
    routeId: fingerprint.routePattern,
    data: {
      routePattern: fingerprint.routePattern,
      pageKind: fingerprint.pageKind,
      signature: fingerprint.signature,
      jobCardCount: fingerprint.jobCardCount,
      dialogCount: fingerprint.dialogCount,
      regions: [...fingerprint.regions],
      markers: [...fingerprint.markers],
      actionLabels: [...fingerprint.actionLabels],
    } satisfies Record<string, JsonValue>,
  });
};
