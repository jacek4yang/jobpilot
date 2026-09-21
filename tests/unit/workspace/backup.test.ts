import { describe, expect, it } from "vitest";
import { createMemoryWorkspaceStorage } from "../../../src/storage/workspace-storage";

describe("Backup & Restore Service", () => {
  it("exports workspace data as versioned schema with counts and checksum", async () => {
    const storage = createMemoryWorkspaceStorage();
    await storage.jobs.saveJob({
      id: "job_1",
      platform: "boss",
      title: "资深测试工程师",
      companyName: "科技公司",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    });
    await storage.annotations.updateNote("job_1", "备选", 1000);

    const backup = await storage.backup.exportBackup("0.2.0", 5000);

    expect(backup.version).toBe(1);
    expect(backup.appVersion).toBe("0.2.0");
    expect(backup.counts.jobs).toBe(1);
    expect(backup.counts.annotations).toBe(1);
    expect(backup.checksum).toMatch(/^c_\w+/);
  });

  it("validates backup schema and provides preview", async () => {
    const storage = createMemoryWorkspaceStorage();
    const valid = {
      version: 1,
      appVersion: "0.2.0",
      exportedAt: 1000,
      checksum: "c_123",
      counts: { jobs: 1, annotations: 1, pipeline: 0, tags: 0, interviews: 0 },
      data: {
        jobs: [{ id: "j1", platform: "boss", title: "测试", companyName: "A" }],
        annotations: [{ jobId: "j1", preference: "favorite", note: "不错" }],
        pipeline: [],
        tags: [],
        interviews: [],
      },
    };

    const res = storage.backup.validateBackup(valid);
    expect(res.valid).toBe(true);
    expect(res.preview?.jobCount).toBe(1);
    expect(res.preview?.notesCount).toBe(1);

    const invalid = { version: 99 };
    const badRes = storage.backup.validateBackup(invalid);
    expect(badRes.valid).toBe(false);
  });

  it("imports backup with merge mode and preserves newer local data", async () => {
    const storage = createMemoryWorkspaceStorage();

    await storage.jobs.saveJob({
      id: "j1",
      platform: "boss",
      title: "本地职位",
      companyName: "本地公司",
      firstSeenAt: 1000,
      lastSeenAt: 2000,
    });
    await storage.annotations.updateNote("j1", "本地更新的备注", 5000);

    const backup = {
      version: 1 as const,
      appVersion: "0.2.0",
      exportedAt: 3000,
      checksum: "c_test",
      counts: { jobs: 1, annotations: 1, pipeline: 0, tags: 0, interviews: 0 },
      data: {
        jobs: [
          {
            id: "j1",
            platform: "boss" as const,
            title: "备份职位",
            companyName: "本地公司",
            firstSeenAt: 800,
            lastSeenAt: 1200,
          },
        ],
        annotations: [
          {
            jobId: "j1",
            preference: "maybe" as const,
            note: "备份旧备注",
            positiveTags: [],
            concernTags: [],
            questionTags: [],
            customTags: [],
            questions: [],
            pinned: false,
            updatedAt: 2000, // Older than 5000
          },
        ],
        pipeline: [],
        tags: [],
        interviews: [],
      },
    };

    await storage.backup.importBackup(backup, "merge");

    const job = await storage.jobs.getJob("j1");
    expect(job?.firstSeenAt).toBe(800); // Earlier timestamp retained

    const ann = await storage.annotations.getAnnotation("j1");
    expect(ann?.note).toBe("本地更新的备注"); // Newer local note was not overwritten
  });
});
