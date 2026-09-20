/**
 * BOSS recruiter-activity reader.
 *
 * Reads recruiter activity from a job detail, scoped to recruiter-specific
 * containers only. The reference implementation demonstrates why this scoping
 * matters: scanning a whole page for activity words like "在线" or "一周内"
 * matches job-description prose and produces false readings.
 *
 * ============================ HONESTY NOTICE ============================
 * The container selectors below are NOT verified against the real BOSS site.
 * They are `unverified` heuristics consistent with the shape the reference
 * implementations expect. When they match nothing, this returns `undefined`
 * and the caller's unknown-activity policy decides what happens.
 * =======================================================================
 */
import type { JobDetail } from "../../domain/job/job";
import {
  pickMostConservativeActivity,
  type RecruiterActivity,
} from "../../domain/recruiter/activity";
import { queryFirst, SELECTORS } from "./selectors";

/**
 * Containers that hold recruiter information, never the job description.
 *
 * Ordered by confidence: semantic/structural anchors first, then class-based
 * guesses that are the most likely to break.
 */
const RECRUITER_CONTAINER_CANDIDATES: readonly string[] = [
  "[data-jobpilot-recruiter]",
  ".job-boss-info",
  ".boss-info",
  ".job-detail-box .boss-info",
  "[class*='boss-info']",
  "[class*='recruiter-info']",
];

/** Elements inside a recruiter container that may carry the activity label. */
const ACTIVITY_TEXT_CANDIDATES: readonly string[] = [
  "[data-jobpilot-activity]",
  ".boss-active-time",
  ".boss-online",
  "span",
  "em",
  "i",
  "p",
  "[class*='active']",
];

export interface ActivityReadResult {
  readonly activity: RecruiterActivity | undefined;
  /** Labels that were considered, for diagnostics. Never includes page prose. */
  readonly labelsConsidered: readonly string[];
}

/**
 * Reads recruiter activity from a job detail element.
 *
 * Returns `undefined` activity when no recruiter container exists, when no
 * label parses, or when the detail did not carry a DOM root. Callers must treat
 * `undefined` as "unknown", not as "inactive".
 */
export const readBossActivity = (root: ParentNode | null): ActivityReadResult => {
  if (root === null) return { activity: undefined, labelsConsidered: [] };

  const labels: string[] = [];

  for (const containerSelector of RECRUITER_CONTAINER_CANDIDATES) {
    let containers: readonly Element[];
    try {
      containers = Array.from(root.querySelectorAll(containerSelector));
    } catch {
      // A selector the environment cannot parse must not break the read.
      continue;
    }
    if (containers.length === 0) continue;

    for (const container of containers) {
      for (const textSelector of ACTIVITY_TEXT_CANDIDATES) {
        let nodes: readonly Element[];
        try {
          nodes = Array.from(container.querySelectorAll(textSelector));
        } catch {
          continue;
        }
        for (const node of [container, ...nodes]) {
          const text = node.textContent;
          if (text === null) continue;
          const trimmed = text.trim();
          // Bound the candidate length: a long string is prose, not a label.
          if (trimmed.length === 0 || trimmed.length > 20) continue;
          labels.push(trimmed);
        }
      }
    }

    // The first container family that yields anything wins; do not mix
    // unrelated regions, which is how contradictory readings creep in.
    if (labels.length > 0) break;
  }

  // Several labels can coexist while the DOM settles. The least active reading
  // is the safe one: optimism here would message a dormant recruiter.
  const activity = pickMostConservativeActivity(labels);
  return { activity, labelsConsidered: labels };
};

/**
 * Adapter-shaped helper for the discovery service.
 *
 * The discovery service only needs the activity, so this unwraps the diagnostic
 * detail. It takes a `JobDetail` because that is what the service has; if the
 * detail carries no DOM root (for example in a unit test) the result is
 * `undefined` and the unknown-activity policy applies.
 */
export const readBossRecruiterActivity = (job: JobDetail): RecruiterActivity | undefined => {
  const root = (job as JobDetail & { readonly root?: ParentNode }).root;
  if (root === undefined) return undefined;
  return readBossActivity(root).activity;
};

/** Reads activity from a detail's DOM root, when the adapter retained one. */
export const activityFromDetailRoot = readBossActivity;

export { queryFirst, SELECTORS };
