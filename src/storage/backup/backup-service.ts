/**
 * Local Backup and Restore Service.
 *
 * Provides safe local export/import of all user workspace data:
 * - Versioned schema (v1)
 * - Pure client-side download/upload (no cloud sync, no server upload)
 * - Validation & integrity preview
 * - Non-destructive merge option and explicit replace confirmation
 */

import { fnv1a32 } from "../../domain/support/shared";
import type {
  CustomTag,
  InterviewRecord,
  JobAnnotation,
  PipelineRecord,
  StoredJob,
} from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupCounts {
  readonly jobs: number;
  readonly annotations: number;
  readonly pipeline: number;
  readonly tags: number;
  readonly interviews: number;
}

export interface JobPilotBackupV1 {
  readonly version: 1;
  readonly appVersion: string;
  readonly exportedAt: number;
  readonly checksum: string;
  readonly counts: BackupCounts;
  readonly data: {
    readonly jobs: readonly StoredJob[];
    readonly annotations: readonly JobAnnotation[];
    readonly pipeline: readonly PipelineRecord[];
    readonly tags: readonly CustomTag[];
    readonly interviews: readonly InterviewRecord[];
  };
}

export interface BackupValidationResult {
  readonly valid: boolean;
  readonly error?: string | undefined;
  readonly backup?: JobPilotBackupV1 | undefined;
  readonly preview?:
    | {
        readonly jobCount: number;
        readonly notesCount: number;
        readonly tagsCount: number;
        readonly exportedDate: string;
      }
    | undefined;
}

export interface BackupService {
  exportBackup(appVersion: string, now: number): Promise<JobPilotBackupV1>;
  validateBackup(raw: unknown): BackupValidationResult;
  importBackup(
    backup: JobPilotBackupV1,
    mode: "merge" | "replace",
  ): Promise<{ importedJobs: number; importedAnnotations: number }>;
}

export const createBackupService = (db: WorkspaceDatabase): BackupService => ({
  async exportBackup(appVersion: string, now: number): Promise<JobPilotBackupV1> {
    const jobs = await db.getAll<StoredJob>(WORKSPACE_STORES.jobs);
    const annotations = await db.getAll<JobAnnotation>(WORKSPACE_STORES.annotations);
    const pipeline = await db.getAll<PipelineRecord>(WORKSPACE_STORES.pipeline);
    const tags = await db.getAll<CustomTag>(WORKSPACE_STORES.tags);
    const interviews = await db.getAll<InterviewRecord>(WORKSPACE_STORES.interviews);

    const counts: BackupCounts = {
      jobs: jobs.length,
      annotations: annotations.length,
      pipeline: pipeline.length,
      tags: tags.length,
      interviews: interviews.length,
    };

    const payload = JSON.stringify({ jobs, annotations, pipeline, tags, interviews });
    const checksum = `c_${fnv1a32(payload)}`;

    return {
      version: 1,
      appVersion,
      exportedAt: now,
      checksum,
      counts,
      data: {
        jobs,
        annotations,
        pipeline,
        tags,
        interviews,
      },
    };
  },

  validateBackup(raw: unknown): BackupValidationResult {
    if (typeof raw !== "object" || raw === null) {
      return { valid: false, error: "备份文件格式无效：非 JSON 对象" };
    }

    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1) {
      return {
        valid: false,
        error: `不支持的备份版本 (当前支持版本: 1, 文件版本: ${String(obj.version)})`,
      };
    }

    if (!obj.data || typeof obj.data !== "object") {
      return { valid: false, error: "备份文件损坏：缺失数据区" };
    }

    const data = obj.data as Record<string, unknown>;
    const jobs = Array.isArray(data.jobs) ? (data.jobs as StoredJob[]) : [];
    const annotations = Array.isArray(data.annotations)
      ? (data.annotations as JobAnnotation[])
      : [];
    const tags = Array.isArray(data.tags) ? (data.tags as CustomTag[]) : [];

    const notesCount = annotations.filter((a) => (a.note ?? "").trim().length > 0).length;
    const exportedAt = typeof obj.exportedAt === "number" ? obj.exportedAt : Date.now();

    const backup = raw as JobPilotBackupV1;

    return {
      valid: true,
      backup,
      preview: {
        jobCount: jobs.length,
        notesCount,
        tagsCount: tags.length,
        exportedDate: new Date(exportedAt).toLocaleDateString("zh-CN"),
      },
    };
  },

  async importBackup(
    backup: JobPilotBackupV1,
    mode: "merge" | "replace",
  ): Promise<{ importedJobs: number; importedAnnotations: number }> {
    if (mode === "replace") {
      await db.clear(WORKSPACE_STORES.jobs);
      await db.clear(WORKSPACE_STORES.annotations);
      await db.clear(WORKSPACE_STORES.pipeline);
      await db.clear(WORKSPACE_STORES.tags);
      await db.clear(WORKSPACE_STORES.interviews);
    }

    // Import Jobs
    let importedJobs = 0;
    for (const job of backup.data.jobs) {
      if (!job.id || !job.companyName || !job.title) continue;
      if (mode === "merge") {
        const existing = await db.get<StoredJob>(WORKSPACE_STORES.jobs, job.id);
        if (existing) {
          // Keep earlier firstSeenAt, update lastSeenAt
          await db.put<StoredJob>(WORKSPACE_STORES.jobs, {
            ...job,
            firstSeenAt: Math.min(existing.firstSeenAt, job.firstSeenAt),
            lastSeenAt: Math.max(existing.lastSeenAt, job.lastSeenAt),
          });
        } else {
          await db.put<StoredJob>(WORKSPACE_STORES.jobs, job);
        }
      } else {
        await db.put<StoredJob>(WORKSPACE_STORES.jobs, job);
      }
      importedJobs++;
    }

    // Import Annotations
    let importedAnnotations = 0;
    for (const ann of backup.data.annotations) {
      if (!ann.jobId) continue;
      if (mode === "merge") {
        const existing = await db.get<JobAnnotation>(WORKSPACE_STORES.annotations, ann.jobId);
        if (existing) {
          // If existing has user edits newer than backup, keep existing user notes
          if (existing.updatedAt >= ann.updatedAt) {
            continue;
          }
        }
      }
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, ann);
      importedAnnotations++;
    }

    // Import Pipeline
    for (const pipe of backup.data.pipeline) {
      if (!pipe.jobId) continue;
      if (mode === "merge") {
        const existing = await db.get<PipelineRecord>(WORKSPACE_STORES.pipeline, pipe.jobId);
        if (existing && existing.updatedAt >= pipe.updatedAt) {
          continue;
        }
      }
      await db.put<PipelineRecord>(WORKSPACE_STORES.pipeline, pipe);
    }

    // Import Tags
    for (const tag of backup.data.tags) {
      if (!tag.id || !tag.name) continue;
      await db.put<CustomTag>(WORKSPACE_STORES.tags, tag);
    }

    // Import Interviews
    for (const interview of backup.data.interviews) {
      if (!interview.id) continue;
      await db.put<InterviewRecord>(WORKSPACE_STORES.interviews, interview);
    }

    return {
      importedJobs,
      importedAnnotations,
    };
  },
});
