/**
 * The versioned JobPilot configuration model.
 *
 * This module is pure data: types, constants, and a factory for the default
 * document. Everything that reads untrusted input lives in `./validate`, and
 * everything that upgrades old documents lives in `./migrations`.
 *
 * Design rule that must not be relaxed: the defaults are the *conservative*
 * ones. A user who never opens the settings panel gets an assistant that
 * suggests work and waits for a human, never an unattended bot.
 */

/**
 * How much the automation is allowed to do on its own.
 *
 * - `manual`    — JobPilot only observes, scores, and explains. No clicks.
 * - `assist`    — JobPilot prepares and pre-fills; a human confirms each step.
 * - `automatic` — JobPilot acts unattended. Opt-in only, see
 *                 {@link AutomationConfig.acknowledgeRisks}.
 */
export type AutomationMode = "manual" | "assist" | "automatic";

/** Never change this to `automatic`. See the module docblock. */
export const DEFAULT_AUTOMATION_MODE: AutomationMode = "assist";

export const AUTOMATION_MODES: readonly AutomationMode[] = ["manual", "assist", "automatic"];

export const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** Identity and locale-ish choices that are not platform specific. */
export interface GeneralConfig {
  /** Master switch. `false` means the runtime stays completely inert. */
  readonly enabled: boolean;
  /** UI + logs language. Kept as a free string; unknown values fall back. */
  readonly locale: string;
  /**
   * Optional local-only user display name for personalized greeting (e.g. "小明").
   * Stored locally only, never transmitted or logged.
   */
  readonly displayName?: string | undefined;
  /** Platform ids that automation is allowed to run on. Empty = all enabled. */
  readonly enabledPlatforms: readonly string[];
  /** `true` pauses everything as soon as a page load starts. */
  readonly pauseOnNavigation: boolean;
}

/** Hard filters. Mirrors `HardFilterConfig` in the domain, plus UI-only knobs. */
export interface FiltersConfig {
  readonly cities: readonly string[];
  /** Salary bounds in thousands of the local currency. */
  readonly minSalaryK: number;
  readonly maxSalaryK: number;
  readonly education: readonly string[];
  readonly experience: readonly string[];
  /** When non-empty, a job must contain at least one of these. */
  readonly includeKeywords: readonly string[];
  /** A job containing any of these is rejected outright. */
  readonly excludeKeywords: readonly string[];
  readonly companyBlacklist: readonly string[];
  readonly excludeOutsourcing: boolean;
  readonly excludeHeadhunter: boolean;
  /** Skip jobs that were already seen in a previous session. */
  readonly skipProcessed: boolean;
}

/** Soft scoring. Mirrors `ScoringConfig` in the domain. */
export interface ScoringConfigSection {
  readonly baseScore: number;
  /** Score at or above which a job is considered a match. */
  readonly acceptThreshold: number;
  /** Hard ceiling used to keep scores comparable across versions. */
  readonly maxScore: number;
  readonly titleKeywords: readonly KeywordWeight[];
  readonly descriptionKeywords: readonly KeywordWeight[];
  readonly preferredSkills: readonly KeywordWeight[];
  readonly preferredCities: readonly KeywordWeight[];
}

/** Re-exported shape of a single weighted keyword. */
export interface KeywordWeight {
  readonly keyword: string;
  readonly weight: number;
}

/** Automation posture and the guards that gate the risky modes. */
export interface AutomationConfig {
  readonly mode: AutomationMode;
  /**
   * Explicit acknowledgement that unattended answering is at the user's own
   * risk and may violate a platform's terms of service.
   *
   * The validator refuses `mode: "automatic"` while this is `false`. Keeping
   * the two as separate fields means the UI can present a checkbox, and it
   * means a hand-edited config file cannot quietly enable the risky mode.
   */
  readonly acknowledgeRisks: boolean;
  /** Stop after this many applications in one browser session. */
  readonly maxApplicationsPerSession: number;
  /** Stop for the remainder of the hour after this many applications. */
  readonly maxApplicationsPerHour: number;
  /** Retries per individual action before the attempt is marked failed. */
  readonly maxRetries: number;
  /** Randomised pause between actions, lower bound, milliseconds. */
  readonly minActionDelayMs: number;
  /** Randomised pause between actions, upper bound, milliseconds. */
  readonly maxActionDelayMs: number;
  /** Re-read the page after submitting to confirm the outcome. */
  readonly verifyAfterSubmit: boolean;
  /** Abort the whole run when the DOM no longer matches expectations. */
  readonly stopOnUnknownDom: boolean;
}

/**
 * Session policy, expressed separately from {@link AutomationConfig} so that
 * the runtime can consume the limits without importing the whole config.
 */
export interface SessionPolicy {
  readonly maxApplicationsPerSession: number;
  readonly maxApplicationsPerHour: number;
  readonly minActionDelayMs: number;
  readonly maxActionDelayMs: number;
  readonly maxRetries: number;
}

/** Extra pacing guards that are not per-session. */
export interface RateLimitConfig {
  /** Minimum gap between two page navigations, milliseconds. */
  readonly minNavigationDelayMs: number;
  /** Pause applied after a single failure before continuing, milliseconds. */
  readonly failureBackoffMs: number;
  /** Consecutive failures that trip the circuit breaker. */
  readonly maxConsecutiveFailures: number;
  /** Stop the run entirely once the circuit breaker trips. */
  readonly stopOnCircuitBreak: boolean;
}

export interface PanelCustomPosition {
  readonly x: number;
  readonly y: number;
}

export type PanelPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | PanelCustomPosition;

/** Presentation-only settings. Never affects decisions. */
export interface UiConfig {
  /** Show the floating control panel. */
  readonly showPanel: boolean;
  /** Panel corner anchor or custom coordinates { x, y }. */
  readonly panelPosition: PanelPosition;
  /** Custom panel width in pixels. */
  readonly panelWidth?: number | undefined;
  /** Custom panel height in pixels. */
  readonly panelHeight?: number | undefined;
  /** Show the per-rule explanation for rejected jobs. */
  readonly showReasons: boolean;
  /** Collapse the panel to a single button on start. */
  readonly compactMode: boolean;
  /** Persisted collapsed state. */
  readonly collapsed?: boolean | undefined;
}

/** Diagnostics. Telemetry is off and there is no code path that turns it on. */
export interface LoggingConfig {
  readonly level: string;
  /** Ring-buffer size for in-memory log entries. */
  readonly maxEntries: number;
  /** Persist log entries across reloads. Off by default: logs can be sensitive. */
  readonly persistLogs: boolean;
  /**
   * Reserved. JobPilot has no telemetry endpoint; this field exists so that a
   * future opt-in is an explicit, visible schema change rather than a silent
   * default flip.
   */
  readonly telemetryEnabled: boolean;
}

/** The complete configuration document. */
export interface JobPilotConfig {
  readonly general: GeneralConfig;
  readonly filters: FiltersConfig;
  readonly scoring: ScoringConfigSection;
  readonly automation: AutomationConfig;
  readonly rateLimit: RateLimitConfig;
  readonly ui: UiConfig;
  readonly logging: LoggingConfig;
  /**
   * Saved search intents.
   *
   * Persisted as a whole list rather than a single global keyword set, because
   * a real job search is several distinct searches that the user switches
   * between. Stored as plain records: the domain owns the shape, and the config
   * layer only guarantees the array survives a round trip.
   */
  readonly profiles: readonly StoredSearchProfile[];
}

/**
 * A search profile as persisted.
 *
 * Kept structurally identical to the domain's `SearchProfile` but declared
 * here so the config layer does not depend on the domain. The mapping is done
 * at the boundary, which keeps the dependency arrow pointing inward.
 */
export interface StoredSearchProfile {
  readonly id: string;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly cities: readonly string[];
  readonly includeKeywords: readonly string[];
  readonly excludeKeywords: readonly string[];
  readonly enabled: boolean;
  readonly salaryMinK?: number;
  readonly salaryMaxK?: number;
  readonly degree?: readonly string[];
  readonly experience?: readonly string[];
  readonly companyScales?: readonly string[];
  readonly recruiterActivity?: string;
  readonly skipUnknownActivity?: boolean;
}

/** Schema revision of {@link JobPilotConfig}. Bump together with a migration. */
export const CURRENT_SCHEMA_VERSION = 5;

export const PANEL_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

export const isAutomationMode = (value: unknown): value is AutomationMode =>
  typeof value === "string" && (AUTOMATION_MODES as readonly string[]).includes(value);

export const isPanelPosition = (value: unknown): value is PanelPosition => {
  if (typeof value === "string") {
    return (PANEL_POSITIONS as readonly string[]).includes(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      typeof record["x"] === "number" &&
      Number.isFinite(record["x"]) &&
      typeof record["y"] === "number" &&
      Number.isFinite(record["y"])
    );
  }
  return false;
};

/**
 * The default document, as a fresh object on every call so that a caller
 * cannot mutate a shared singleton (and so tests stay independent).
 */
export const createDefaultConfig = (): JobPilotConfig => ({
  general: {
    enabled: true,
    locale: "zh-CN",
    enabledPlatforms: [],
    pauseOnNavigation: false,
  },
  filters: {
    cities: [],
    minSalaryK: 0,
    maxSalaryK: 0,
    education: [],
    experience: [],
    includeKeywords: [],
    excludeKeywords: [],
    companyBlacklist: [],
    excludeOutsourcing: true,
    excludeHeadhunter: false,
    skipProcessed: true,
  },
  scoring: {
    baseScore: 50,
    acceptThreshold: 70,
    maxScore: 100,
    titleKeywords: [],
    descriptionKeywords: [],
    preferredSkills: [],
    preferredCities: [],
  },
  automation: {
    mode: DEFAULT_AUTOMATION_MODE,
    acknowledgeRisks: false,
    maxApplicationsPerSession: 20,
    maxApplicationsPerHour: 15,
    maxRetries: 2,
    minActionDelayMs: 4000,
    maxActionDelayMs: 9000,
    verifyAfterSubmit: true,
    stopOnUnknownDom: true,
  },
  rateLimit: {
    minNavigationDelayMs: 2000,
    failureBackoffMs: 30000,
    maxConsecutiveFailures: 3,
    stopOnCircuitBreak: true,
  },
  ui: {
    showPanel: true,
    panelPosition: "bottom-right",
    showReasons: true,
    compactMode: false,
  },
  logging: {
    level: "info",
    maxEntries: 500,
    persistLogs: false,
    telemetryEnabled: false,
  },
  // Starts empty on purpose. Shipping a preset keyword list would silently
  // filter every new user's results down to one person's job search.
  profiles: [],
});

/** Projects the automation section onto the runtime-facing session policy. */
export const toSessionPolicy = (config: JobPilotConfig): SessionPolicy => ({
  maxApplicationsPerSession: config.automation.maxApplicationsPerSession,
  maxApplicationsPerHour: config.automation.maxApplicationsPerHour,
  minActionDelayMs: config.automation.minActionDelayMs,
  maxActionDelayMs: config.automation.maxActionDelayMs,
  maxRetries: config.automation.maxRetries,
});
