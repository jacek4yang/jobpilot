/**
 * Lightweight Job Pipeline Repository.
 *
 * Tracks recruitment progress through simple stages:
 * 刚发现 -> 喜欢 -> 准备沟通 -> 已沟通 -> 有回复 -> 待面试 -> 已面试 -> 收到 Offer -> 不考虑 -> 已结束
 */

import type { JobStage, PipelineRecord, StageHistoryItem } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface PipelineRepository {
  getPipeline(jobId: string): Promise<PipelineRecord | undefined>;
  setStage(jobId: string, stage: JobStage, now: number, note?: string): Promise<PipelineRecord>;
  listByStage(stage: JobStage): Promise<readonly PipelineRecord[]>;
  listAll(): Promise<readonly PipelineRecord[]>;
  getStageCounts(): Promise<Record<JobStage, number>>;
  deletePipeline(jobId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export const createPipelineRepository = (db: WorkspaceDatabase): PipelineRepository => ({
  async getPipeline(jobId: string): Promise<PipelineRecord | undefined> {
    return db.get<PipelineRecord>(WORKSPACE_STORES.pipeline, jobId);
  },

  async setStage(
    jobId: string,
    stage: JobStage,
    now: number,
    note?: string,
  ): Promise<PipelineRecord> {
    const existing = await db.get<PipelineRecord>(WORKSPACE_STORES.pipeline, jobId);
    const historyItem: StageHistoryItem = {
      stage,
      timestamp: now,
      note,
    };

    const history = existing ? [...existing.history, historyItem] : [historyItem];
    const record: PipelineRecord = {
      jobId,
      stage,
      updatedAt: now,
      history,
    };

    await db.put<PipelineRecord>(WORKSPACE_STORES.pipeline, record);
    return record;
  },

  async listByStage(stage: JobStage): Promise<readonly PipelineRecord[]> {
    const all = await db.getAll<PipelineRecord>(WORKSPACE_STORES.pipeline);
    return all.filter((r) => r.stage === stage).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async listAll(): Promise<readonly PipelineRecord[]> {
    const all = await db.getAll<PipelineRecord>(WORKSPACE_STORES.pipeline);
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getStageCounts(): Promise<Record<JobStage, number>> {
    const all = await db.getAll<PipelineRecord>(WORKSPACE_STORES.pipeline);
    const counts: Record<JobStage, number> = {
      discovered: 0,
      favorite: 0,
      considering: 0,
      "ready-to-contact": 0,
      contacted: 0,
      replied: 0,
      "interview-planned": 0,
      interviewed: 0,
      offer: 0,
      "not-interested": 0,
      closed: 0,
    };

    for (const r of all) {
      if (r.stage in counts) {
        counts[r.stage]++;
      }
    }

    return counts;
  },

  async deletePipeline(jobId: string): Promise<void> {
    await db.delete(WORKSPACE_STORES.pipeline, jobId);
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.pipeline);
  },
});
