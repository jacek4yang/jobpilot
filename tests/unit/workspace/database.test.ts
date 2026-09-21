import { describe, expect, it } from "vitest";
import { createMemoryWorkspaceDatabase } from "../../../src/storage/database/database";
import { WORKSPACE_STORES } from "../../../src/storage/database/schema";

describe("Workspace Database", () => {
  it("supports get, put, delete, count and clear in memory", async () => {
    const db = createMemoryWorkspaceDatabase();

    expect(await db.count(WORKSPACE_STORES.jobs)).toBe(0);

    const testJob = {
      id: "job_1",
      platform: "boss" as const,
      title: "前端工程师",
      companyName: "科技公司",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    };

    await db.put(WORKSPACE_STORES.jobs, testJob);
    expect(await db.count(WORKSPACE_STORES.jobs)).toBe(1);

    const retrieved = await db.get(WORKSPACE_STORES.jobs, "job_1");
    expect(retrieved).toEqual(testJob);

    const all = await db.getAll(WORKSPACE_STORES.jobs);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(testJob);

    await db.delete(WORKSPACE_STORES.jobs, "job_1");
    expect(await db.count(WORKSPACE_STORES.jobs)).toBe(0);
    expect(await db.get(WORKSPACE_STORES.jobs, "job_1")).toBeUndefined();
  });

  it("supports index queries in memory", async () => {
    const db = createMemoryWorkspaceDatabase();

    const ann1 = { jobId: "j1", preference: "favorite", updatedAt: 100 };
    const ann2 = { jobId: "j2", preference: "maybe", updatedAt: 200 };
    const ann3 = { jobId: "j3", preference: "favorite", updatedAt: 300 };

    await db.put(WORKSPACE_STORES.annotations, ann1);
    await db.put(WORKSPACE_STORES.annotations, ann2);
    await db.put(WORKSPACE_STORES.annotations, ann3);

    const favorites = await db.getAllFromIndex(
      WORKSPACE_STORES.annotations,
      "preference",
      "favorite",
    );
    expect(favorites).toHaveLength(2);
    expect(favorites.map((f) => (f as { jobId: string }).jobId)).toEqual(["j1", "j3"]);
  });

  it("calculates approximate storage size", async () => {
    const db = createMemoryWorkspaceDatabase();
    await db.put(WORKSPACE_STORES.tags, { id: "t1", name: "离家近", createdAt: 1000 });
    const size = await db.estimateSize();
    expect(size).toBeGreaterThan(0);
  });
});
