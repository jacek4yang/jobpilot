/**
 * Unified Workspace Storage Service.
 *
 * Bundles all domain repositories, backup service, and database health under a single facade.
 */

import { type BackupService, createBackupService } from "./backup/backup-service";
import {
  createMemoryWorkspaceDatabase,
  type IndexedDbOptions,
  openWorkspaceDatabase,
  type WorkspaceDatabase,
} from "./database/database";
import {
  type AnnotationRepository,
  createAnnotationRepository,
} from "./repositories/annotation-repository";
import {
  createInterviewRepository,
  type InterviewRepository,
} from "./repositories/interview-repository";
import { createJobRepository, type JobRepository } from "./repositories/job-repository";
import {
  createPipelineRepository,
  type PipelineRepository,
} from "./repositories/pipeline-repository";
import {
  createSearchSessionRepository,
  type SearchSessionRepository,
} from "./repositories/search-session-repository";
import { createTagRepository, type TagRepository } from "./repositories/tag-repository";
import {
  createTimelineRepository,
  type TimelineRepository,
} from "./repositories/timeline-repository";
import { applyRetentionPolicy } from "./retention/retention";

export interface WorkspaceStorage {
  readonly db: WorkspaceDatabase;
  readonly jobs: JobRepository;
  readonly annotations: AnnotationRepository;
  readonly pipeline: PipelineRepository;
  readonly tags: TagRepository;
  readonly timeline: TimelineRepository;
  readonly interviews: InterviewRepository;
  readonly searchSessions: SearchSessionRepository;
  readonly backup: BackupService;
  prune(now: number): Promise<{ prunedSessions: number; prunedTimeline: number }>;
  close(): void;
}

export const createWorkspaceStorageWithDb = (db: WorkspaceDatabase): WorkspaceStorage => {
  const jobs = createJobRepository(db);
  const annotations = createAnnotationRepository(db);
  const pipeline = createPipelineRepository(db);
  const tags = createTagRepository(db);
  const timeline = createTimelineRepository(db);
  const interviews = createInterviewRepository(db);
  const searchSessions = createSearchSessionRepository(db);
  const backup = createBackupService(db);

  return {
    db,
    jobs,
    annotations,
    pipeline,
    tags,
    timeline,
    interviews,
    searchSessions,
    backup,
    async prune(now: number) {
      return applyRetentionPolicy(db, now);
    },
    close() {
      db.close();
    },
  };
};

export const createMemoryWorkspaceStorage = (): WorkspaceStorage =>
  createWorkspaceStorageWithDb(createMemoryWorkspaceDatabase());

export const openWorkspaceStorage = async (
  options: IndexedDbOptions = {},
): Promise<WorkspaceStorage> => {
  const db = await openWorkspaceDatabase(options);
  return createWorkspaceStorageWithDb(db);
};
