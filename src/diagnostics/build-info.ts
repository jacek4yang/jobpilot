/**
 * Build identity.
 *
 * Every runtime knows exactly which artifact it is. This matters for
 * diagnostics: a support bundle whose build does not match the source tree is
 * not actionable, so the identity is embedded at build time and travels with
 * every export.
 *
 * `gitCommit` is read from git at build time and falls back to the literal
 * `"unknown"`. It is never fabricated: a plausible-looking but wrong commit is
 * worse than an honest gap.
 */

export type BuildChannel = "production" | "diagnostic";

export interface BuildInfo {
  readonly appVersion: string;
  /** Full git SHA, or `"unknown"` when git was unavailable at build time. */
  readonly gitCommit: string;
  /** ISO-8601 build time, or `"unknown"`. */
  readonly buildTimestamp: string;
  readonly channel: BuildChannel;
  /** Persisted-document schema version this build writes. */
  readonly schemaVersion: number;
  /** Support-bundle format version this build emits. */
  readonly diagnosticSchemaVersion: number;
}

/**
 * Bundle format version.
 *
 * Bump only for a breaking change to the bundle layout. The analyzer refuses a
 * bundle it cannot interpret rather than guessing, and older bundles stay
 * analysable through an explicit migration.
 */
export const DIAGNOSTIC_SCHEMA_VERSION = 1;

/** Values injected by the build. Absent in tests, hence the fallbacks. */
declare const __JOBPILOT_VERSION__: string | undefined;
declare const __JOBPILOT_COMMIT__: string | undefined;
declare const __JOBPILOT_BUILD_TIME__: string | undefined;
declare const __JOBPILOT_CHANNEL__: string | undefined;

const readInjected = (value: string | undefined, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

export const isDiagnosticChannel = (channel: BuildChannel): boolean => channel === "diagnostic";

/**
 * Resolves the build identity for this runtime.
 *
 * `schemaVersion` is passed in rather than imported so this module has no
 * dependency on the config layer, keeping it usable from the analyzer's tooling
 * as well as from the userscript.
 */
export const resolveBuildInfo = (schemaVersion: number): BuildInfo => {
  const rawChannel = readInjected(
    typeof __JOBPILOT_CHANNEL__ === "string" ? __JOBPILOT_CHANNEL__ : undefined,
    "production",
  );
  return {
    appVersion: readInjected(
      typeof __JOBPILOT_VERSION__ === "string" ? __JOBPILOT_VERSION__ : undefined,
      "0.0.0-dev",
    ),
    gitCommit: readInjected(
      typeof __JOBPILOT_COMMIT__ === "string" ? __JOBPILOT_COMMIT__ : undefined,
      "unknown",
    ),
    buildTimestamp: readInjected(
      typeof __JOBPILOT_BUILD_TIME__ === "string" ? __JOBPILOT_BUILD_TIME__ : undefined,
      "unknown",
    ),
    channel: rawChannel === "diagnostic" ? "diagnostic" : "production",
    schemaVersion,
    diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
  };
};

/** A build info usable in tests and in non-injected contexts. */
export const createBuildInfo = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  appVersion: "0.0.0-test",
  gitCommit: "unknown",
  buildTimestamp: "unknown",
  channel: "production",
  schemaVersion: 4,
  diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
  ...overrides,
});

/**
 * A short, filesystem-safe build tag for bundle filenames.
 *
 * e.g. `0.1.0_a1b2c3d` or `0.1.0_unknown`.
 */
export const buildTag = (build: BuildInfo): string => {
  const commit = build.gitCommit === "unknown" ? "unknown" : build.gitCommit.slice(0, 7);
  const safeVersion = build.appVersion.replace(/[^A-Za-z0-9.-]/g, "_");
  return `${safeVersion}_${commit}`;
};
