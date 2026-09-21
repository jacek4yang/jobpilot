/**
 * Search Session Repository.
 *
 * Persists recent search sessions for informational context without pressure.
 */

import type { SearchSession } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface SearchSessionRepository {
  saveSession(session: SearchSession): Promise<void>;
  listRecentSessions(limit?: number): Promise<readonly SearchSession[]>;
  clearAll(): Promise<void>;
}

export const createSearchSessionRepository = (db: WorkspaceDatabase): SearchSessionRepository => ({
  async saveSession(session: SearchSession): Promise<void> {
    await db.put<SearchSession>(WORKSPACE_STORES.searchSessions, session);
  },

  async listRecentSessions(limit = 10): Promise<readonly SearchSession[]> {
    const all = await db.getAll<SearchSession>(WORKSPACE_STORES.searchSessions);
    return [...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.searchSessions);
  },
});
