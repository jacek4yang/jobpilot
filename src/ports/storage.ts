/**
 * Storage port.
 *
 * Every persistence path in JobPilot goes through this interface. No other
 * module may call `GM_getValue` / `GM_setValue` / `GM_deleteValue` directly,
 * which keeps the domain testable under Node.js and the GM surface auditable.
 */
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys currently persisted. Used by diagnostics and export. */
  keys(): Promise<readonly string[]>;
}
