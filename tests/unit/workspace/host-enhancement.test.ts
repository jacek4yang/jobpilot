import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createHostEnhancer } from "../../../src/ui/host-enhancement/enhancer";

describe("HostEnhancer", () => {
  it("injects badges into matching job cards and removes them on dispose", async () => {
    const window = new Window({ url: "https://www.zhipin.com/web/geek/job" });
    const doc = window.document;

    doc.body.innerHTML = `
      <div class="job-list-box">
        <div class="job-card-wrapper" data-job-id="job_123">
          <span class="job-name">前端工程师</span>
        </div>
      </div>
    `;

    const enhancer = createHostEnhancer({
      document: doc as unknown as Document,
      async getBadgeData(jobId) {
        if (jobId === "job_123") {
          return {
            preference: "favorite",
            stage: "contacted",
            hasNote: true,
            score: 92,
          };
        }
        return undefined;
      },
    });

    enhancer.start();

    // Allow promise microtasks to run
    await new Promise((r) => setTimeout(r, 10));

    const card = doc.querySelector(".job-card-wrapper");
    expect(card?.getAttribute("data-jobpilot-enhanced")).toBe("true");

    const badgeContainer = card?.querySelector("[data-jobpilot-badge-container]");
    expect(badgeContainer).not.toBeNull();
    expect(badgeContainer?.textContent).toContain("💗 喜欢");
    expect(badgeContainer?.textContent).toContain("已沟通");
    expect(badgeContainer?.textContent).toContain("有备注");
    expect(badgeContainer?.textContent).toContain("匹配 92");

    // Dispose must completely restore original DOM
    enhancer.dispose();

    expect(card?.hasAttribute("data-jobpilot-enhanced")).toBe(false);
    expect(card?.querySelector("[data-jobpilot-badge-container]")).toBeNull();
    expect(doc.getElementById("jobpilot-host-styles")).toBeNull();
  });

  it("injects summary trigger on job detail page and removes on dispose", async () => {
    const window = new Window({ url: "https://www.zhipin.com/job_detail/abc.html" });
    const doc = window.document;

    doc.body.innerHTML = `
      <div class="job-detail-box">
        <h1 class="name">测试开发专家</h1>
      </div>
    `;

    let opened = false;
    const enhancer = createHostEnhancer({
      document: doc as unknown as Document,
      async getBadgeData() {
        return undefined;
      },
      onOpenJobSummary() {
        opened = true;
      },
    });

    enhancer.start();

    const btn = doc.querySelector(
      "[data-jobpilot-summary-trigger]",
    ) as unknown as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("JobPilot 摘要");

    btn.click();
    expect(opened).toBe(true);

    enhancer.dispose();
    expect(doc.querySelector("[data-jobpilot-summary-trigger]")).toBeNull();
  });
});
