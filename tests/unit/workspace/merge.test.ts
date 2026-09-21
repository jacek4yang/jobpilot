import { describe, expect, it } from "vitest";
import { mergeJobSnapshot } from "../../../src/domain/workspace/merge";
import type { StoredJob } from "../../../src/domain/workspace/types";

describe("Three-way merge policy", () => {
  it("creates a fresh record with firstSeenAt and lastSeenAt set to current timestamp", () => {
    const fresh = mergeJobSnapshot(
      undefined,
      {
        id: "123",
        platform: "boss",
        title: "测试开发工程师",
        companyName: "某科技公司",
        salaryRaw: "15-25K",
      },
      { now: 2000 },
    );

    expect(fresh.id).toBe("123");
    expect(fresh.title).toBe("测试开发工程师");
    expect(fresh.firstSeenAt).toBe(2000);
    expect(fresh.lastSeenAt).toBe(2000);
  });

  it("preserves firstSeenAt when re-visiting an existing job posting", () => {
    const existing: StoredJob = {
      id: "123",
      platform: "boss",
      title: "测试工程师",
      companyName: "某科技公司",
      salaryRaw: "15-20K",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    };

    const merged = mergeJobSnapshot(
      existing,
      {
        id: "123",
        platform: "boss",
        title: "测试开发工程师",
        companyName: "某科技公司",
        salaryRaw: "18-25K",
      },
      { now: 5000 },
    );

    expect(merged.firstSeenAt).toBe(1000);
    expect(merged.lastSeenAt).toBe(5000);
    expect(merged.salaryRaw).toBe("18-25K");
    expect(merged.title).toBe("测试开发工程师");
  });

  it("does not erase known existing fields when incoming data is missing or undefined", () => {
    const existing: StoredJob = {
      id: "123",
      platform: "boss",
      title: "高级前端",
      companyName: "字节跃动",
      locationRaw: "西安高新",
      city: "西安",
      district: "高新",
      description: "负责前端架构建设",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    };

    const merged = mergeJobSnapshot(
      existing,
      {
        id: "123",
        platform: "boss",
        title: "高级前端",
        companyName: "字节跃动",
        // Notice description & district omitted in incoming partial scan
      },
      { now: 3000 },
    );

    expect(merged.locationRaw).toBe("西安高新");
    expect(merged.city).toBe("西安");
    expect(merged.district).toBe("高新");
    expect(merged.description).toBe("负责前端架构建设");
  });
});
