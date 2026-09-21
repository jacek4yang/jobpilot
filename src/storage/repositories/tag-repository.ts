/**
 * Custom Tags Repository.
 *
 * Persists user-defined custom tags for filtering and organization.
 */

import type { CustomTag } from "../../domain/workspace/types";
import type { WorkspaceDatabase } from "../database/database";
import { WORKSPACE_STORES } from "../database/schema";

export interface TagRepository {
  listTags(): Promise<readonly CustomTag[]>;
  createTag(name: string, now: number, color?: string): Promise<CustomTag>;
  renameTag(id: string, newName: string): Promise<void>;
  deleteTag(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export const createTagRepository = (db: WorkspaceDatabase): TagRepository => ({
  async listTags(): Promise<readonly CustomTag[]> {
    const all = await db.getAll<CustomTag>(WORKSPACE_STORES.tags);
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  },

  async createTag(name: string, now: number, color?: string): Promise<CustomTag> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Tag name cannot be empty");

    const all = await db.getAll<CustomTag>(WORKSPACE_STORES.tags);
    const existing = all.find((t) => t.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) return existing;

    const id = `tag_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const tag: CustomTag = {
      id,
      name: cleanName,
      color,
      createdAt: now,
    };

    await db.put<CustomTag>(WORKSPACE_STORES.tags, tag);
    return tag;
  },

  async renameTag(id: string, newName: string): Promise<void> {
    const tag = await db.get<CustomTag>(WORKSPACE_STORES.tags, id);
    if (!tag) return;
    const cleanName = newName.trim();
    if (!cleanName) return;

    await db.put<CustomTag>(WORKSPACE_STORES.tags, {
      ...tag,
      name: cleanName,
    });
  },

  async deleteTag(id: string): Promise<void> {
    await db.delete(WORKSPACE_STORES.tags, id);
  },

  async clearAll(): Promise<void> {
    await db.clear(WORKSPACE_STORES.tags);
  },
});
