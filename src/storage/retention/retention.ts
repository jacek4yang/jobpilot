/**
 * Retention Policy for JobPilot Workspace Storage.
 *
 * Prunes non-critical transient entries to prevent uncontrolled IndexedDB growth:
 * - Prunes search sessions older than retention cutoff (default 60 days)
 * - Prunes timeline events exceeding per-job history limit (default 50 events)
 *
 * Strict Invariant:
 * - NEVER automatically prunes or deletes user favorites, notes, custom tags, or pipeline records.
 */

import type { TimelineEvent } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface RetentionOptions {
  readonly maxSearchSessionAgeMs?: number | undefined;
  readonly maxTimelineEventsPerJob?: number | undefined;
}

const DEFAULT_SESSION_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const DEFAULT_TIMELINE_PER_JOB = 50;

export const applyRetentionPolicy = async (
  db: WorkspaceDatabase,
  now: number,
  options: RetentionOptions = {},
): Promise<{ prunedSessions: number; prunedTimeline: number }> => {
  const maxAge = options.maxSearchSessionAgeMs ?? DEFAULT_SESSION_AGE_MS;
  const maxTimeline = options.maxTimelineEventsPerJob ?? DEFAULT_TIMELINE_PER_JOB;

  let prunedSessions = 0;
  let prunedTimeline = 0;

  // 1. Prune old search sessions
  const sessions = await db.getAll<{ id: string; startedAt: number }>(
    WORKSPACE_STORES.searchSessions,
  );
  for (const session of sessions) {
    if (now - session.startedAt > maxAge) {
      await db.delete(WORKSPACE_STORES.searchSessions, session.id);
      prunedSessions++;
    }
  }

  // 2. Prune excess timeline events per job
  const timeline = await db.getAll<TimelineEvent>(WORKSPACE_STORES.timeline);
  const byJob = new Map<string, TimelineEvent[]>();
  for (const evt of timeline) {
    const list = byJob.get(evt.jobId) ?? [];
    list.push(evt);
    byJob.set(evt.jobId, list);
  }

  for (const list of byJob.values()) {
    if (list.length > maxTimeline) {
      // Sort oldest first and delete the oldest ones beyond maxTimeline
      list.sort((a, b) => a.timestamp - b.timestamp);
      const toDelete = list.slice(0, list.length - maxTimeline);
      for (const item of toDelete) {
        await db.delete(WORKSPACE_STORES.timeline, item.id);
        prunedTimeline++;
      }
    }
  }

  return {
    prunedSessions,
    prunedTimeline,
  };
};
