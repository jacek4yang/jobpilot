/**
 * Timeline Event Repository.
 *
 * Records high-level milestones for job interaction:
 * (看到职位 -> 标记喜欢 -> 准备沟通 -> 已沟通 -> 有回复 -> 面试安排)
 */

import type { TimelineEvent } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface TimelineRepository {
  addEvent(event: TimelineEvent): Promise<void>;
  listEventsForJob(jobId: string): Promise<readonly TimelineEvent[]>;
  listRecentEvents(limit?: number): Promise<readonly TimelineEvent[]>;
  clearAll(): Promise<void>;
}

export const createTimelineRepository = (db: WorkspaceDatabase): TimelineRepository => ({
  async addEvent(event: TimelineEvent): Promise<void> {
    await db.put<TimelineEvent>(WORKSPACE_STORES.timeline, event);
  },

  async listEventsForJob(jobId: string): Promise<readonly TimelineEvent[]> {
    const all = await db.getAllFromIndex<TimelineEvent>(WORKSPACE_STORES.timeline, "jobId", jobId);
    return [...all].sort((a, b) => b.timestamp - a.timestamp);
  },

  async listRecentEvents(limit = 20): Promise<readonly TimelineEvent[]> {
    const all = await db.getAll<TimelineEvent>(WORKSPACE_STORES.timeline);
    return [...all].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.timeline);
  },
});
