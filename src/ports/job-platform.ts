import type { JobDetail, JobSummary } from "../domain/job/job";

/**
 * What kind of page the adapter believes it is looking at.
 *
 * Detection must be evidence-based. `unknown` is a first-class outcome and
 * callers must fail closed on it rather than guessing.
 */
export type PageKind =
  | "job-list"
  | "job-detail"
  | "chat"
  | "login-required"
  | "captcha"
  | "empty-result"
  | "unsupported"
  | "unknown";

/**
 * Reasons an adapter refuses to continue. These are safety signals: the
 * automation must pause and fail closed, never attempt to work around them.
 */
export type BlockReason =
  | "captcha"
  | "risk-control"
  | "login-expired"
  | "unknown-dom"
  | "selector-missing"
  | "ambiguous-state"
  | "rate-limited";

/** A resolved DOM target plus the strategy that found it, for diagnostics. */
export interface LocatedElement {
  readonly element: Element;
  /** Selector or strategy description that matched. */
  readonly matchedBy: string;
  /** True when the match relied on a heuristic rather than a stable anchor. */
  readonly heuristic: boolean;
}

export interface ScanOptions {
  /** Maximum number of summaries to return. Adapters may return fewer. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface PlatformOperationOptions {
  readonly signal?: AbortSignal;
}

/**
 * The contract every job platform adapter implements.
 *
 * Adding a platform means adding an adapter, never changing the domain,
 * state machine, queue or storage layers.
 */
export interface JobPlatform {
  readonly id: string;
  /** Human-readable name for UI and diagnostics. */
  readonly displayName: string;

  detectPage(): PageKind;

  scanJobs(options?: ScanOptions): Promise<readonly JobSummary[]>;

  loadJob(job: JobSummary, options?: PlatformOperationOptions): Promise<JobDetail>;
}
