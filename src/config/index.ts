/**
 * Public configuration API.
 *
 * `schema` is the trusted model, `validate` turns untrusted input into it, and
 * `migrations` upgrades documents written by older builds. Nothing outside
 * this directory should reach into the individual modules.
 */

export type {
  AutomationConfig,
  AutomationMode,
  FiltersConfig,
  GeneralConfig,
  JobPilotConfig,
  KeywordWeight,
  LoggingConfig,
  RateLimitConfig,
  ScoringConfigSection,
  SessionPolicy,
  UiConfig,
} from "./schema";
export {
  AUTOMATION_MODES,
  CURRENT_SCHEMA_VERSION,
  createDefaultConfig,
  DEFAULT_AUTOMATION_MODE,
  isAutomationMode,
  isPanelPosition,
  LOG_LEVELS,
  PANEL_POSITIONS,
  toSessionPolicy,
} from "./schema";

export type { PersistedRoot } from "./persisted";

export type { NumberBounds, ValidationResult } from "./validate";
export {
  isRecord,
  readBoolean,
  readKeywordWeights,
  readNumber,
  readString,
  readStringArray,
  validateConfig,
  validateConfigJson,
} from "./validate";

export type { MigrationResult } from "./migrations";
export { isCurrentVersion, MIGRATION_STEPS, migratePersistedRoot } from "./migrations";
