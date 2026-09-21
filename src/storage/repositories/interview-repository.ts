/**
 * Interview Record Repository.
 *
 * Persists user-authored interview schedules, notes, format, and results.
 */

import type { InterviewRecord } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface InterviewRepository {
  getInterview(id: string): Promise<InterviewRecord | undefined>;
  getInterviewForJob(jobId: string): Promise<InterviewRecord | undefined>;
  saveInterview(record: InterviewRecord): Promise<void>;
  deleteInterview(id: string): Promise<void>;
  listInterviews(): Promise<readonly InterviewRecord[]>;
  clearAll(): Promise<void>;
}

export const createInterviewRepository = (db: WorkspaceDatabase): InterviewRepository => ({
  async getInterview(id: string): Promise<InterviewRecord | undefined> {
    return db.get<InterviewRecord>(WORKSPACE_STORES.interviews, id);
  },

  async getInterviewForJob(jobId: string): Promise<InterviewRecord | undefined> {
    const all = await db.getAllFromIndex<InterviewRecord>(
      WORKSPACE_STORES.interviews,
      "jobId",
      jobId,
    );
    return all[0];
  },

  async saveInterview(record: InterviewRecord): Promise<void> {
    await db.put<InterviewRecord>(WORKSPACE_STORES.interviews, record);
  },

  async deleteInterview(id: string): Promise<void> {
    await db.delete(WORKSPACE_STORES.interviews, id);
  },

  async listInterviews(): Promise<readonly InterviewRecord[]> {
    const all = await db.getAll<InterviewRecord>(WORKSPACE_STORES.interviews);
    return [...all].sort((a, b) => (b.scheduledAt ?? b.updatedAt) - (a.scheduledAt ?? a.updatedAt));
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.interviews);
  },
});
