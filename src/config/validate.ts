/**
 * Runtime validation of persisted / imported configuration.
 *
 * The contract, in order of importance:
 *
 * 1. **Never throw.** Persisted JSON is untrusted input. It may be truncated,
 *    hand-edited, written by a future version, or be a hostile blob from a
 *    shared config file. Every entry point returns a discriminated result.
 * 2. **Report everything.** All problems are collected, not just the first, so
 *    the panel can show the user one complete list.
 * 3. **Missing is fine, wrong is not.** An absent field falls back to the
 *    default; a field of the wrong *type* is an error. Silent coercion of
 *    `"yes"` into a boolean would hide a user's real intent.
 * 4. **Conservative on conflict.** If the stored document asks for
 *    `automatic` without an explicit risk acknowledgement, validation fails
 *    rather than downgrading silently — the user must see why.
 */

import type {
  AutomationConfig,
  AutomationMode,
  FiltersConfig,
  GeneralConfig,
  JobPilotConfig,
  KeywordWeight,
  LoggingConfig,
  RateLimitConfig,
  ScoringConfigSection,
  UiConfig,
} from "./schema";
import { createDefaultConfig, isAutomationMode, isPanelPosition, LOG_LEVELS } from "./schema";

export type ValidationResult =
  | { readonly ok: true; readonly value: JobPilotConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Mutable error accumulator; keeps the reader functions pure-ish and short. */
type Report = (message: string) => void;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads an optional string. Absent (`undefined`) is not an error; any other
 * non-string is, and falls back to the default.
 */
export const readString = (
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  report: Report,
  path: string,
): string => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  report(`${path} must be a string`);
  return fallback;
};

export const readBoolean = (
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  report: Report,
  path: string,
): boolean => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  report(`${path} must be a boolean`);
  return fallback;
};

export interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
  /** When true the value must be an integer. */
  readonly integer?: boolean;
}

/**
 * Reads an optional number and range-checks it.
 *
 * `NaN` and `Infinity` are rejected explicitly: they pass `typeof === "number"`
 * but break every downstream comparison (`NaN < x` is always false, which
 * would silently disable a limit).
 */
export const readNumber = (
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  report: Report,
  path: string,
  bounds: NumberBounds = {},
): number => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    report(`${path} must be a finite number`);
    return fallback;
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    report(`${path} must be an integer`);
    return fallback;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    report(`${path} must be >= ${bounds.min}`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    report(`${path} must be <= ${bounds.max}`);
    return fallback;
  }
  return value;
};

/** Reads an optional array of strings, dropping nothing and reporting types. */
export const readStringArray = (
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  report: Report,
  path: string,
): readonly string[] => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    report(`${path} must be an array of strings`);
    return fallback;
  }
  const output: string[] = [];
  let bad = false;
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== "string") {
      bad = true;
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) output.push(trimmed);
  }
  if (bad) report(`${path} must contain only strings`);
  return output;
};

/** Reads an optional array of `{ keyword, weight }` entries. */
export const readKeywordWeights = (
  source: Record<string, unknown>,
  key: string,
  fallback: readonly KeywordWeight[],
  report: Report,
  path: string,
): readonly KeywordWeight[] => {
  const value = source[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    report(`${path} must be an array of keyword weights`);
    return fallback;
  }
  const output: KeywordWeight[] = [];
  let bad = false;
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (!isRecord(item)) {
      bad = true;
      continue;
    }
    const keyword = item["keyword"];
    const weight = item["weight"];
    if (typeof keyword !== "string" || typeof weight !== "number" || !Number.isFinite(weight)) {
      bad = true;
      continue;
    }
    const trimmed = keyword.trim();
    if (trimmed.length === 0) {
      bad = true;
      continue;
    }
    output.push({ keyword: trimmed, weight });
  }
  if (bad) report(`${path} entries must be { keyword: string, weight: number }`);
  return output;
};

/**
 * Resolves a section of the input to an object.
 *
 * A section that is present but not an object is an error; a section that is
 * missing falls back to an empty object so that every field inside it is then
 * filled from the defaults individually (this is what makes migrations that
 * add a field safe).
 */
const sectionOf = (
  root: Record<string, unknown>,
  key: string,
  report: Report,
  path: string,
): Record<string, unknown> => {
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    report(`${path} must be an object`);
    return {};
  }
  return value;
};

const validateGeneral = (
  section: Record<string, unknown>,
  fallback: GeneralConfig,
  report: Report,
): GeneralConfig => ({
  enabled: readBoolean(section, "enabled", fallback.enabled, report, "general.enabled"),
  locale: readString(section, "locale", fallback.locale, report, "general.locale"),
  enabledPlatforms: readStringArray(
    section,
    "enabledPlatforms",
    fallback.enabledPlatforms,
    report,
    "general.enabledPlatforms",
  ),
  pauseOnNavigation: readBoolean(
    section,
    "pauseOnNavigation",
    fallback.pauseOnNavigation,
    report,
    "general.pauseOnNavigation",
  ),
});

const validateFilters = (
  section: Record<string, unknown>,
  fallback: FiltersConfig,
  report: Report,
): FiltersConfig => {
  const minSalaryK = readNumber(
    section,
    "minSalaryK",
    fallback.minSalaryK,
    report,
    "filters.minSalaryK",
    { min: 0 },
  );
  const maxSalaryK = readNumber(
    section,
    "maxSalaryK",
    fallback.maxSalaryK,
    report,
    "filters.maxSalaryK",
    { min: 0 },
  );
  // 0 is the documented "no bound" sentinel on either side, so only compare
  // when both are real bounds.
  if (minSalaryK > 0 && maxSalaryK > 0 && minSalaryK > maxSalaryK) {
    report("filters.minSalaryK must be <= filters.maxSalaryK");
  }
  return {
    cities: readStringArray(section, "cities", fallback.cities, report, "filters.cities"),
    minSalaryK,
    maxSalaryK,
    education: readStringArray(
      section,
      "education",
      fallback.education,
      report,
      "filters.education",
    ),
    experience: readStringArray(
      section,
      "experience",
      fallback.experience,
      report,
      "filters.experience",
    ),
    includeKeywords: readStringArray(
      section,
      "includeKeywords",
      fallback.includeKeywords,
      report,
      "filters.includeKeywords",
    ),
    excludeKeywords: readStringArray(
      section,
      "excludeKeywords",
      fallback.excludeKeywords,
      report,
      "filters.excludeKeywords",
    ),
    companyBlacklist: readStringArray(
      section,
      "companyBlacklist",
      fallback.companyBlacklist,
      report,
      "filters.companyBlacklist",
    ),
    excludeOutsourcing: readBoolean(
      section,
      "excludeOutsourcing",
      fallback.excludeOutsourcing,
      report,
      "filters.excludeOutsourcing",
    ),
    excludeHeadhunter: readBoolean(
      section,
      "excludeHeadhunter",
      fallback.excludeHeadhunter,
      report,
      "filters.excludeHeadhunter",
    ),
    skipProcessed: readBoolean(
      section,
      "skipProcessed",
      fallback.skipProcessed,
      report,
      "filters.skipProcessed",
    ),
  };
};

const validateScoring = (
  section: Record<string, unknown>,
  fallback: ScoringConfigSection,
  report: Report,
): ScoringConfigSection => {
  const baseScore = readNumber(
    section,
    "baseScore",
    fallback.baseScore,
    report,
    "scoring.baseScore",
    {
      min: 0,
    },
  );
  const acceptThreshold = readNumber(
    section,
    "acceptThreshold",
    fallback.acceptThreshold,
    report,
    "scoring.acceptThreshold",
    { min: 0 },
  );
  const maxScore = readNumber(section, "maxScore", fallback.maxScore, report, "scoring.maxScore", {
    min: 0,
  });
  if (maxScore > 0 && acceptThreshold > maxScore) {
    report("scoring.acceptThreshold must be <= scoring.maxScore");
  }
  return {
    baseScore,
    acceptThreshold,
    maxScore,
    titleKeywords: readKeywordWeights(
      section,
      "titleKeywords",
      fallback.titleKeywords,
      report,
      "scoring.titleKeywords",
    ),
    descriptionKeywords: readKeywordWeights(
      section,
      "descriptionKeywords",
      fallback.descriptionKeywords,
      report,
      "scoring.descriptionKeywords",
    ),
    preferredSkills: readKeywordWeights(
      section,
      "preferredSkills",
      fallback.preferredSkills,
      report,
      "scoring.preferredSkills",
    ),
    preferredCities: readKeywordWeights(
      section,
      "preferredCities",
      fallback.preferredCities,
      report,
      "scoring.preferredCities",
    ),
  };
};

const validateAutomation = (
  section: Record<string, unknown>,
  fallback: AutomationConfig,
  report: Report,
): AutomationConfig => {
  const rawMode: unknown = section["mode"];
  let mode: AutomationMode = fallback.mode;
  if (rawMode !== undefined) {
    if (isAutomationMode(rawMode)) {
      mode = rawMode;
    } else {
      report(`automation.mode must be one of manual | assist | automatic`);
    }
  }

  const acknowledgeRisks = readBoolean(
    section,
    "acknowledgeRisks",
    fallback.acknowledgeRisks,
    report,
    "automation.acknowledgeRisks",
  );

  // The conservative-by-default gate. Unattended applications can violate a
  // platform's terms of service, so the risky mode is never reachable by
  // accident: it requires the explicit acknowledgement flag in the same
  // document, and a config file copied from someone else fails closed.
  if (mode === "automatic" && !acknowledgeRisks) {
    report('automation.mode "automatic" requires automation.acknowledgeRisks to be true');
  }

  const minActionDelayMs = readNumber(
    section,
    "minActionDelayMs",
    fallback.minActionDelayMs,
    report,
    "automation.minActionDelayMs",
    { min: 0 },
  );
  const maxActionDelayMs = readNumber(
    section,
    "maxActionDelayMs",
    fallback.maxActionDelayMs,
    report,
    "automation.maxActionDelayMs",
    { min: 0 },
  );
  if (minActionDelayMs > maxActionDelayMs) {
    report("automation.minActionDelayMs must be <= automation.maxActionDelayMs");
  }

  return {
    mode,
    acknowledgeRisks,
    maxApplicationsPerSession: readNumber(
      section,
      "maxApplicationsPerSession",
      fallback.maxApplicationsPerSession,
      report,
      "automation.maxApplicationsPerSession",
      { min: 0, integer: true },
    ),
    maxApplicationsPerHour: readNumber(
      section,
      "maxApplicationsPerHour",
      fallback.maxApplicationsPerHour,
      report,
      "automation.maxApplicationsPerHour",
      { min: 0, integer: true },
    ),
    maxRetries: readNumber(
      section,
      "maxRetries",
      fallback.maxRetries,
      report,
      "automation.maxRetries",
      {
        min: 0,
        integer: true,
      },
    ),
    minActionDelayMs,
    maxActionDelayMs,
    verifyAfterSubmit: readBoolean(
      section,
      "verifyAfterSubmit",
      fallback.verifyAfterSubmit,
      report,
      "automation.verifyAfterSubmit",
    ),
    stopOnUnknownDom: readBoolean(
      section,
      "stopOnUnknownDom",
      fallback.stopOnUnknownDom,
      report,
      "automation.stopOnUnknownDom",
    ),
  };
};

const validateRateLimit = (
  section: Record<string, unknown>,
  fallback: RateLimitConfig,
  report: Report,
): RateLimitConfig => ({
  minNavigationDelayMs: readNumber(
    section,
    "minNavigationDelayMs",
    fallback.minNavigationDelayMs,
    report,
    "rateLimit.minNavigationDelayMs",
    { min: 0 },
  ),
  failureBackoffMs: readNumber(
    section,
    "failureBackoffMs",
    fallback.failureBackoffMs,
    report,
    "rateLimit.failureBackoffMs",
    { min: 0 },
  ),
  maxConsecutiveFailures: readNumber(
    section,
    "maxConsecutiveFailures",
    fallback.maxConsecutiveFailures,
    report,
    "rateLimit.maxConsecutiveFailures",
    { min: 0, integer: true },
  ),
  stopOnCircuitBreak: readBoolean(
    section,
    "stopOnCircuitBreak",
    fallback.stopOnCircuitBreak,
    report,
    "rateLimit.stopOnCircuitBreak",
  ),
});

const validateUi = (
  section: Record<string, unknown>,
  fallback: UiConfig,
  report: Report,
): UiConfig => {
  const rawPosition: unknown = section["panelPosition"];
  let panelPosition: UiConfig["panelPosition"] = fallback.panelPosition;
  if (rawPosition !== undefined) {
    if (isPanelPosition(rawPosition)) {
      panelPosition = rawPosition;
    } else {
      report("ui.panelPosition must be one of top-left | top-right | bottom-left | bottom-right");
    }
  }
  return {
    showPanel: readBoolean(section, "showPanel", fallback.showPanel, report, "ui.showPanel"),
    panelPosition,
    showReasons: readBoolean(
      section,
      "showReasons",
      fallback.showReasons,
      report,
      "ui.showReasons",
    ),
    compactMode: readBoolean(
      section,
      "compactMode",
      fallback.compactMode,
      report,
      "ui.compactMode",
    ),
  };
};

const validateLogging = (
  section: Record<string, unknown>,
  fallback: LoggingConfig,
  report: Report,
): LoggingConfig => {
  const level = readString(section, "level", fallback.level, report, "logging.level");
  if (!LOG_LEVELS.includes(level)) {
    report(`logging.level must be one of ${LOG_LEVELS.join(" | ")}`);
  }
  const telemetryEnabled = readBoolean(
    section,
    "telemetryEnabled",
    fallback.telemetryEnabled,
    report,
    "logging.telemetryEnabled",
  );
  // JobPilot ships no telemetry endpoint. Accepting `true` here would suggest
  // otherwise, so it is rejected the same way an unknown level is.
  if (telemetryEnabled) report("logging.telemetryEnabled must be false; JobPilot has no telemetry");
  return {
    level,
    maxEntries: readNumber(
      section,
      "maxEntries",
      fallback.maxEntries,
      report,
      "logging.maxEntries",
      {
        min: 0,
        integer: true,
      },
    ),
    persistLogs: readBoolean(
      section,
      "persistLogs",
      fallback.persistLogs,
      report,
      "logging.persistLogs",
    ),
    telemetryEnabled,
  };
};

/**
 * Validates arbitrary input into a complete {@link JobPilotConfig}.
 *
 * Unknown extra keys are ignored (forward compatibility: a newer version's
 * fields survive as dead weight rather than causing a hard failure). Missing
 * keys are filled from {@link createDefaultConfig}. Wrong types are errors.
 */
export const validateConfig = (input: unknown): ValidationResult => {
  const errors: string[] = [];
  const report: Report = (message) => {
    errors.push(message);
  };

  const defaults = createDefaultConfig();
  // A non-object root is one single error rather than a cascade: reporting
  // "general must be an object" once per section for a `null` input is noise.
  const root = isRecord(input) ? input : {};
  if (!isRecord(input)) {
    report("config root must be an object");
  }

  const value: JobPilotConfig = {
    general: validateGeneral(
      sectionOf(root, "general", report, "general"),
      defaults.general,
      report,
    ),
    filters: validateFilters(
      sectionOf(root, "filters", report, "filters"),
      defaults.filters,
      report,
    ),
    scoring: validateScoring(
      sectionOf(root, "scoring", report, "scoring"),
      defaults.scoring,
      report,
    ),
    automation: validateAutomation(
      sectionOf(root, "automation", report, "automation"),
      defaults.automation,
      report,
    ),
    rateLimit: validateRateLimit(
      sectionOf(root, "rateLimit", report, "rateLimit"),
      defaults.rateLimit,
      report,
    ),
    ui: validateUi(sectionOf(root, "ui", report, "ui"), defaults.ui, report),
    logging: validateLogging(
      sectionOf(root, "logging", report, "logging"),
      defaults.logging,
      report,
    ),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
};

/**
 * Validates a serialised config document.
 *
 * Split out from {@link validateConfig} so that import/export can distinguish
 * "not JSON at all" (a syntax problem the user must fix) from "JSON with the
 * wrong shape" (a schema problem).
 */
export const validateConfigJson = (text: string): ValidationResult => {
  if (typeof text !== "string") {
    return { ok: false, errors: ["config text must be a string"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse error";
    return { ok: false, errors: [`config is not valid JSON: ${detail}`] };
  }
  return validateConfig(parsed);
};
