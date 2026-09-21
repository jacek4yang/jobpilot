/**
 * Personal Annotation Repository.
 *
 * Persists and queries user-authored notes, preferences, tags, and question checklists.
 */

import {
  createDefaultAnnotation,
  type JobAnnotation,
  type PersonalPreference,
  type QuestionItem,
} from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface AnnotationFilterOptions {
  readonly preference?: PersonalPreference | undefined;
  readonly pinnedOnly?: boolean | undefined;
}

export interface AnnotationRepository {
  getAnnotation(jobId: string): Promise<JobAnnotation | undefined>;
  getOrCreateAnnotation(jobId: string, now: number): Promise<JobAnnotation>;
  saveAnnotation(annotation: JobAnnotation): Promise<void>;
  updatePreference(
    jobId: string,
    preference: PersonalPreference,
    now: number,
  ): Promise<JobAnnotation>;
  updateNote(jobId: string, note: string, now: number): Promise<JobAnnotation>;
  togglePin(jobId: string, now: number): Promise<JobAnnotation>;
  toggleTag(
    jobId: string,
    tagCategory: "positive" | "concern" | "question" | "custom",
    tagName: string,
    now: number,
  ): Promise<JobAnnotation>;
  updateQuestions(
    jobId: string,
    questions: readonly QuestionItem[],
    now: number,
  ): Promise<JobAnnotation>;
  listFavorites(): Promise<readonly JobAnnotation[]>;
  listAnnotations(options?: AnnotationFilterOptions): Promise<readonly JobAnnotation[]>;
  countAnnotations(): Promise<number>;
  clearAll(): Promise<void>;
}

export const createAnnotationRepository = (db: WorkspaceDatabase): AnnotationRepository => {
  const getOrCreate = async (jobId: string, now: number): Promise<JobAnnotation> => {
    const existing = await db.get<JobAnnotation>(WORKSPACE_STORES.annotations, jobId);
    if (existing) return existing;
    return createDefaultAnnotation(jobId, now);
  };

  return {
    async getAnnotation(jobId: string): Promise<JobAnnotation | undefined> {
      return db.get<JobAnnotation>(WORKSPACE_STORES.annotations, jobId);
    },

    getOrCreateAnnotation: getOrCreate,

    async saveAnnotation(annotation: JobAnnotation): Promise<void> {
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, annotation);
    },

    async updatePreference(
      jobId: string,
      preference: PersonalPreference,
      now: number,
    ): Promise<JobAnnotation> {
      const current = await getOrCreate(jobId, now);
      const updated: JobAnnotation = {
        ...current,
        preference,
        updatedAt: now,
      };
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, updated);
      return updated;
    },

    async updateNote(jobId: string, note: string, now: number): Promise<JobAnnotation> {
      const current = await getOrCreate(jobId, now);
      const updated: JobAnnotation = {
        ...current,
        note: note.trim() || undefined,
        updatedAt: now,
      };
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, updated);
      return updated;
    },

    async togglePin(jobId: string, now: number): Promise<JobAnnotation> {
      const current = await getOrCreate(jobId, now);
      const updated: JobAnnotation = {
        ...current,
        pinned: !current.pinned,
        updatedAt: now,
      };
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, updated);
      return updated;
    },

    async toggleTag(
      jobId: string,
      tagCategory: "positive" | "concern" | "question" | "custom",
      tagName: string,
      now: number,
    ): Promise<JobAnnotation> {
      const current = await getOrCreate(jobId, now);
      const targetListKey =
        tagCategory === "positive"
          ? "positiveTags"
          : tagCategory === "concern"
            ? "concernTags"
            : tagCategory === "question"
              ? "questionTags"
              : "customTags";

      const list = [...current[targetListKey]];
      const index = list.indexOf(tagName);
      if (index >= 0) {
        list.splice(index, 1);
      } else {
        list.push(tagName);
      }

      const updated: JobAnnotation = {
        ...current,
        [targetListKey]: list,
        updatedAt: now,
      };
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, updated);
      return updated;
    },

    async updateQuestions(
      jobId: string,
      questions: readonly QuestionItem[],
      now: number,
    ): Promise<JobAnnotation> {
      const current = await getOrCreate(jobId, now);
      const updated: JobAnnotation = {
        ...current,
        questions,
        updatedAt: now,
      };
      await db.put<JobAnnotation>(WORKSPACE_STORES.annotations, updated);
      return updated;
    },

    async listFavorites(): Promise<readonly JobAnnotation[]> {
      const all = await db.getAll<JobAnnotation>(WORKSPACE_STORES.annotations);
      return all
        .filter((a) => a.preference === "favorite" || a.preference === "interested")
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async listAnnotations(
      options: AnnotationFilterOptions = {},
    ): Promise<readonly JobAnnotation[]> {
      const all = await db.getAll<JobAnnotation>(WORKSPACE_STORES.annotations);
      let filtered = all;

      if (options.preference) {
        filtered = filtered.filter((a) => a.preference === options.preference);
      }
      if (options.pinnedOnly) {
        filtered = filtered.filter((a) => a.pinned);
      }

      return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async countAnnotations(): Promise<number> {
      return db.count(WORKSPACE_STORES.annotations);
    },

    async clearAll(): Promise<void> {
      await db.clear(WORKSPACE_STORES.annotations);
    },
  };
};
