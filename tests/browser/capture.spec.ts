import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  GUARDED_ORIGIN,
  HOST_MAPPING_ARGS,
  isBuildPresent,
  loadHarness,
  MISSING_BUILD_MESSAGE,
  PANEL_HOST,
  PANEL_ROOT,
  waitForPanel,
} from "./harness";

test.use({
  launchOptions: { args: HOST_MAPPING_ARGS },
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

test.describe("Render screenshots for README", () => {
  const outputDir = resolve(process.cwd(), "docs/images");

  test.beforeAll(() => {
    test.skip(!isBuildPresent(), MISSING_BUILD_MESSAGE);
    mkdirSync(outputDir, { recursive: true });
  });

  test("captures overview and home screenshots on job-list fixture", async ({ page }) => {
    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    const panelHost = page.locator(PANEL_HOST).first();
    const panelRoot = panelHost.locator(PANEL_ROOT).first();
    await expect(panelRoot).toBeVisible();

    // 1. Capture full page overview showing BOSS list + JobPilot panel in top-right
    await page.screenshot({
      path: resolve(outputDir, "jobpilot-overview.png"),
      fullPage: false,
    });

    // 2. Capture Home dashboard panel
    await panelRoot.screenshot({
      path: resolve(outputDir, "jobpilot-home.png"),
    });
  });

  test("captures workspace companion screenshot on job-detail fixture", async ({ page }) => {
    await loadHarness(page, "job-detail.html");
    expect(await waitForPanel(page)).toBe(true);

    const panelHost = page.locator(PANEL_HOST).first();
    const panelRoot = panelHost.locator(PANEL_ROOT).first();
    await expect(panelRoot).toBeVisible();

    // Navigate to "职位" (Jobs workspace) tab
    const jobsTab = panelRoot.locator('.jobpilot-tab[data-tab="jobs"]').first();
    await jobsTab.click();

    const jobsPanel = panelRoot.locator('.jobpilot-panel[data-panel="jobs"]').first();
    await expect(jobsPanel).toHaveAttribute("data-active", "true");

    // Click "💗 很喜欢" feeling button
    const favBtn = jobsPanel.locator(".jobpilot-pref-btn").filter({ hasText: "很喜欢" }).first();
    if (await favBtn.isVisible()) {
      await favBtn.click();
    }

    // Enter a thoughtful candidate note
    const noteArea = jobsPanel.locator(".jobpilot-textarea").first();
    if (await noteArea.isVisible()) {
      await noteArea.fill(
        "技术栈以 React + TypeScript 为主，与过往项目经验高度契合；团队业务发展稳定，关注晋升发展机制与弹性考勤。面试前需梳理前端工程化与性能优化实战案例。",
      );
      await noteArea.dispatchEvent("input");
      await page.waitForTimeout(800);
    }

    // Capture Jobs workspace
    await panelRoot.screenshot({
      path: resolve(outputDir, "jobpilot-workspace.png"),
    });
  });

  test("captures pipeline board screenshot", async ({ page }) => {
    // Seed pipeline data into IndexedDB first
    await page.goto(`${GUARDED_ORIGIN}/health`);
    await page.evaluate(() => {
      return new Promise<void>((resolvePromise, rejectPromise) => {
        const req = indexedDB.open("jobpilot_workspace_db", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("jobs")) {
            db.createObjectStore("jobs", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("pipeline")) {
            db.createObjectStore("pipeline", { keyPath: "jobId" });
          }
          if (!db.objectStoreNames.contains("interviews")) {
            db.createObjectStore("interviews", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("annotations")) {
            db.createObjectStore("annotations", { keyPath: "jobId" });
          }
          if (!db.objectStoreNames.contains("tags")) {
            db.createObjectStore("tags", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("timeline")) {
            db.createObjectStore("timeline", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("searchSessions")) {
            db.createObjectStore("searchSessions", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("metadata")) {
            db.createObjectStore("metadata", { keyPath: "key" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["jobs", "pipeline", "interviews", "annotations"], "readwrite");
          const jobStore = tx.objectStore("jobs");
          const pipeStore = tx.objectStore("pipeline");
          const intStore = tx.objectStore("interviews");
          const annoStore = tx.objectStore("annotations");

          const now = Date.now();

          // Seed jobs
          jobStore.put({
            id: "job-101",
            platform: "boss",
            title: "资深前端技术专家",
            companyName: "未来科技有限公司",
            salaryRaw: "28-45K·15薪",
            city: "北京·朝阳",
            firstSeenAt: now - 86400000,
            lastSeenAt: now,
          });
          jobStore.put({
            id: "job-102",
            platform: "boss",
            title: "全栈开发架构师",
            companyName: "云图智能网络",
            salaryRaw: "32-50K·14薪",
            city: "上海·浦东",
            firstSeenAt: now - 86400000 * 2,
            lastSeenAt: now,
          });
          jobStore.put({
            id: "job-103",
            platform: "boss",
            title: "前端技术负责人",
            companyName: "星云数字化科技",
            salaryRaw: "35-55K·16薪",
            city: "深圳·南山",
            firstSeenAt: now - 86400000 * 3,
            lastSeenAt: now,
          });
          jobStore.put({
            id: "job-104",
            platform: "boss",
            title: "Web 平台研发工程师",
            companyName: "智联卓越创新",
            salaryRaw: "25-38K",
            city: "杭州·西湖",
            firstSeenAt: now - 86400000 * 4,
            lastSeenAt: now,
          });

          // Seed pipeline stages
          pipeStore.put({
            jobId: "job-101",
            stage: "interview-planned",
            updatedAt: now,
            history: [{ stage: "interview-planned", timestamp: now, note: "一面通知" }],
          });
          pipeStore.put({
            jobId: "job-102",
            stage: "contacted",
            updatedAt: now - 3600000,
            history: [{ stage: "contacted", timestamp: now - 3600000 }],
          });
          pipeStore.put({
            jobId: "job-103",
            stage: "ready-to-contact",
            updatedAt: now - 7200000,
            history: [{ stage: "ready-to-contact", timestamp: now - 7200000 }],
          });
          pipeStore.put({
            jobId: "job-104",
            stage: "replied",
            updatedAt: now - 10800000,
            history: [{ stage: "replied", timestamp: now - 10800000 }],
          });

          // Seed interview for job-101
          intStore.put({
            id: "int-101",
            jobId: "job-101",
            scheduledAt: now + 86400000 * 2,
            format: "online",
            location: "腾讯会议 (视频终面)",
            notes: "总监技术面，准备核心架构设计与性能度量案例",
            createdAt: now,
            updatedAt: now,
          });

          annoStore.put({
            jobId: "job-101",
            preference: "favorite",
            pinned: true,
            positiveTags: ["弹性考勤", "核心团队", "薪资优渥"],
            concernTags: [],
            questionTags: [],
            customTags: [],
            questions: [],
            updatedAt: now,
          });

          tx.oncomplete = () => {
            db.close();
            resolvePromise();
          };
          tx.onerror = () => {
            db.close();
            rejectPromise(tx.error);
          };
        };
        req.onerror = () => rejectPromise(req.error);
      });
    });

    await loadHarness(page, "job-list.html");
    expect(await waitForPanel(page)).toBe(true);

    const panelHost = page.locator(PANEL_HOST).first();
    const panelRoot = panelHost.locator(PANEL_ROOT).first();
    await expect(panelRoot).toBeVisible();

    // Click "进展" tab
    const pipelineTab = panelRoot.locator('.jobpilot-tab[data-tab="pipeline"]').first();
    await pipelineTab.click();

    const pipelinePanel = panelRoot.locator('.jobpilot-panel[data-panel="pipeline"]').first();
    await expect(pipelinePanel).toHaveAttribute("data-active", "true");

    // Click "待面试" stage tile so the interview record is displayed
    const tiles = pipelinePanel.locator(".jobpilot-stage-tile");
    const count = await tiles.count();
    for (let i = 0; i < count; i++) {
      const tile = tiles.nth(i);
      const name = await tile.locator(".jobpilot-stage-name").textContent();
      if (name?.includes("待面试")) {
        await tile.click();
        break;
      }
    }

    await page.waitForTimeout(300);

    // Capture Pipeline board
    await panelRoot.screenshot({
      path: resolve(outputDir, "jobpilot-pipeline.png"),
    });
  });
});
