/**
 * Composition root.
 *
 * The only place where concrete adapters are constructed and wired to the
 * application layer. Everything below this module depends on ports, never on
 * implementations, which is what keeps the domain testable under Node.js.
 */
import { createBossPlatform } from "../adapters/boss";
import { GMStorage } from "../adapters/storage/gm-storage";
import { MemoryStorage } from "../adapters/storage/memory-storage";
import type { JobPilotConfig } from "../config/schema";
import { toSessionPolicy } from "../config/schema";
import { createRuleEngine } from "../domain/engine";
import type { Clock, Random } from "../domain/support/shared";
import { mathRandom, systemClock } from "../domain/support/shared";
import { createLogger } from "../infrastructure/logging/logger";
import type { JobPlatform } from "../ports/job-platform";
import type { Logger, LogLevel } from "../ports/logger";
import type { Storage } from "../ports/storage";

/** Injected by the build so the panel and diagnostics agree on the version. */
declare const __JOBPILOT_VERSION__: string | undefined;

export const VERSION: string =
  typeof __JOBPILOT_VERSION__ === "string" ? __JOBPILOT_VERSION__ : "0.0.0-dev";

export interface RuntimeDeps {
  readonly platform: JobPlatform;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
  readonly config: JobPilotConfig;
  readonly version: string;
}

/**
 * Detects whether the GM storage APIs are actually available.
 *
 * A userscript may run in a context where the grants were not applied (for
 * example when the file is loaded as a plain script during development). In
 * that case we fall back to in-memory storage so the panel still works, and we
 * say so in the logs rather than failing silently.
 */
const hasGmStorage = (): boolean =>
  typeof globalThis !== "undefined" &&
  typeof (globalThis as Record<string, unknown>)["GM_getValue"] === "function" &&
  typeof (globalThis as Record<string, unknown>)["GM_setValue"] === "function";

const LOG_LEVEL_SET: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

const isLogLevel = (value: string): value is LogLevel => LOG_LEVEL_SET.has(value);

export const createRuntimeDeps = (config: JobPilotConfig): RuntimeDeps => {
  const clock = systemClock;
  const random = mathRandom;

  const storageAvailable = hasGmStorage();
  const storage: Storage = storageAvailable ? new GMStorage() : new MemoryStorage();

  const logger = createLogger({
    clock,
    minLevel: isLogLevel(config.logging.level) ? config.logging.level : "info",
    capacity: config.logging.maxEntries,
  });

  if (!storageAvailable) {
    logger.warn("bootstrap", "GM storage unavailable; using in-memory storage", {
      consequence: "settings and application history will not survive a reload",
    });
  }

  const platform: JobPlatform = createBossPlatform({
    document: globalThis.document,
    location: globalThis.location,
    logger,
    clock,
    version: VERSION,
  });

  return { platform, storage, logger, clock, random, config, version: VERSION };
};

/** Builds the rule engine from the loaded configuration. */
export const createEngineFor = (config: JobPilotConfig) =>
  createRuleEngine({
    hard: config.filters,
    scoring: config.scoring,
  });

export { toSessionPolicy };
