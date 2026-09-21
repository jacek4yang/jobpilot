/**
 * Job Snapshot Repository.
 *
 * Persists and queries normalized job records extracted from BOSS.
 */

import type { StoredJob } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface JobFilterOptions {
  readonly limit?: number | undefined;
  readonly companyName?: string | undefined;
  readonly city?: string | undefined;
  readonly query?: string | undefined;
}

export interface JobRepository {
  getJob(id: string): Promise<StoredJob | undefined>;
  saveJob(job: StoredJob): Promise<void>;
  deleteJob(id: string): Promise<void>;
  listJobs(options?: JobFilterOptions): Promise<readonly StoredJob[]>;
  countJobs(): Promise<number>;
  clearAll(): Promise<void>;
}

export const createJobRepository = (db: WorkspaceDatabase): JobRepository => ({
  async getJob(id: string): Promise<StoredJob | undefined> {
    return db.get<StoredJob>(WORKSPACE_STORES.jobs, id);
  },

  async saveJob(job: StoredJob): Promise<void> {
    await db.put<StoredJob>(WORKSPACE_STORES.jobs, job);
  },

  async deleteJob(id: string): Promise<void> {
    await db.delete(WORKSPACE_STORES.jobs, id);
  },

  async listJobs(options: JobFilterOptions = {}): Promise<readonly StoredJob[]> {
    const all = await db.getAll<StoredJob>(WORKSPACE_STORES.jobs);

    let filtered = all;
    if (options.companyName) {
      const lower = options.companyName.toLowerCase();
      filtered = filtered.filter((j) => j.companyName.toLowerCase().includes(lower));
    }
    if (options.city) {
      const lower = options.city.toLowerCase();
      filtered = filtered.filter((j) => (j.city ?? "").toLowerCase().includes(lower));
    }
    if (options.query) {
      const lower = options.query.toLowerCase();
      filtered = filtered.filter(
        (j) =>
          j.title.toLowerCase().includes(lower) ||
          j.companyName.toLowerCase().includes(lower) ||
          (j.skills ?? []).some((s) => s.toLowerCase().includes(lower)),
      );
    }

    // Sort by last seen descending
    filtered = [...filtered].sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    if (options.limit && options.limit > 0) {
      return filtered.slice(0, options.limit);
    }
    return filtered;
  },

  async countJobs(): Promise<number> {
    return db.count(WORKSPACE_STORES.jobs);
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.jobs);
  },
});
