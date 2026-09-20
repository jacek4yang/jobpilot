/**
 * Build-freshness helpers.
 *
 * Both channel verifiers need the same question answered: was this artifact
 * produced from the current source, or is it a leftover from an earlier build?
 *
 * That question matters because the two channels share `dist/` (Vite's
 * `emptyOutDir` is disabled so one build cannot delete the other's output), so
 * a stale artifact survives in place. Verifying it would report success for
 * code that no longer exists — the most misleading kind of green.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Newest `.ts` modification time under a directory, in epoch milliseconds.
 *
 * Returns `undefined` when the directory cannot be read, so a permissions
 * problem reports as "freshness could not be checked" rather than as a
 * spurious failure.
 */
export const newestSourceMtime = (directory: string): number | undefined => {
  let newest: number | undefined;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const stats = statSync(path);
        if (stats.isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        if (newest === undefined || stats.mtimeMs > newest) newest = stats.mtimeMs;
      } catch {
        // A file that vanished mid-walk is not a verification failure.
      }
    }
  };

  walk(directory);
  return newest;
};

export interface FreshnessVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

/** Compares an artifact's embedded build time against the newest source file. */
export const checkFreshness = (
  builtAt: number,
  sourceDirectory: string,
  rebuildCommand: string,
): FreshnessVerdict => {
  const newest = newestSourceMtime(sourceDirectory);
  if (newest === undefined) {
    return { ok: true, detail: "source freshness could not be checked (directory unreadable)" };
  }
  if (builtAt < newest) {
    return {
      ok: false,
      detail: `artifact was built at ${new Date(builtAt).toISOString()}, before the newest source change at ${new Date(newest).toISOString()}. Re-run \`${rebuildCommand}\`.`,
    };
  }
  return { ok: true, detail: `built ${new Date(builtAt).toISOString()}` };
};
