import { describe, expect, it } from "vitest";
import { createMemoryWorkspaceStorage } from "../../../src/storage/workspace-storage";

describe("Workspace Repositories", () => {
  it("manages annotations, preferences, notes, and tags", async () => {
    const storage = createMemoryWorkspaceStorage();
    const now = 1000;

    // 1. Initial annotation is created automatically
    const ann = await storage.annotations.getOrCreateAnnotation("job_1", now);
    expect(ann.preference).toBe("unset");
    expect(ann.pinned).toBe(false);

    // 2. Update preference to favorite
    const fav = await storage.annotations.updatePreference("job_1", "favorite", now + 10);
    expect(fav.preference).toBe("favorite");

    // 3. Update note
    const noted = await storage.annotations.updateNote("job_1", "团队技术栈很契合", now + 20);
    expect(noted.note).toBe("团队技术栈很契合");

    // 4. Toggle tags
    await storage.annotations.toggleTag("job_1", "positive", "薪资不错", now + 30);
    const withTag = await storage.annotations.getAnnotation("job_1");
    expect(withTag?.positiveTags).toContain("薪资不错");

    // 5. Toggle pin
    const pinned = await storage.annotations.togglePin("job_1", now + 40);
    expect(pinned.pinned).toBe(true);

    // 6. List favorites
    const favorites = await storage.annotations.listFavorites();
    expect(favorites).toHaveLength(1);
    expect(favorites[0]?.jobId).toBe("job_1");
  });

  it("manages pipeline stages and history tracking", async () => {
    const storage = createMemoryWorkspaceStorage();

    await storage.pipeline.setStage("job_1", "favorite", 1000, "初筛看中");
    await storage.pipeline.setStage("job_1", "ready-to-contact", 2000, "准备首句招呼");
    await storage.pipeline.setStage("job_1", "contacted", 3000, "已发送沟通");

    const pipe = await storage.pipeline.getPipeline("job_1");
    expect(pipe?.stage).toBe("contacted");
    expect(pipe?.history).toHaveLength(3);
    expect(pipe?.history[0]?.stage).toBe("favorite");
    expect(pipe?.history[2]?.stage).toBe("contacted");

    const counts = await storage.pipeline.getStageCounts();
    expect(counts.contacted).toBe(1);
    expect(counts.favorite).toBe(0);
  });

  it("manages custom tags", async () => {
    const storage = createMemoryWorkspaceStorage();

    const tag1 = await storage.tags.createTag("离家近", 1000, "#ff5500");
    expect(tag1.name).toBe("离家近");

    const tags = await storage.tags.listTags();
    expect(tags).toHaveLength(1);

    await storage.tags.renameTag(tag1.id, "通勤极快");
    const updatedTags = await storage.tags.listTags();
    expect(updatedTags[0]?.name).toBe("通勤极快");

    await storage.tags.deleteTag(tag1.id);
    expect(await storage.tags.listTags()).toHaveLength(0);
  });

  it("manages interview records", async () => {
    const storage = createMemoryWorkspaceStorage();

    await storage.interviews.saveInterview({
      id: "int_1",
      jobId: "job_1",
      scheduledAt: 5000,
      format: "online",
      location: "腾讯会议",
      notes: "复习算法与分布式",
      createdAt: 1000,
      updatedAt: 1000,
    });

    const interview = await storage.interviews.getInterviewForJob("job_1");
    expect(interview?.format).toBe("online");
    expect(interview?.location).toBe("腾讯会议");
  });
});
