import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { readBossActivity } from "../../../src/adapters/boss/activity";

/**
 * Builds a DOM from a body fragment.
 *
 * Returns the body element so the reader is exercised against a realistic
 * `ParentNode`, which is what the adapter passes in production.
 */
const dom = (html: string): HTMLElement => {
  const window = new Window({ url: "https://www.zhipin.com/web/geek/job" });
  window.document.body.innerHTML = html;
  return window.document.body as unknown as HTMLElement;
};

describe("BOSS recruiter activity reader", () => {
  describe("scoped reading", () => {
    it("reads a label from a recruiter container", () => {
      const root = dom(`
        <div class="job-detail-box">
          <div class="boss-info"><span class="boss-active-time">今日活跃</span></div>
        </div>
      `);
      const result = readBossActivity(root);
      expect(result.activity?.recency).toBe("today");
      expect(result.activity?.label).toBe("今日活跃");
    });

    it("ignores activity words that appear in the job description", () => {
      // The reference scanned whole regions for these substrings, which matches
      // prose. Scoping to recruiter containers is what prevents that.
      const root = dom(`
        <div class="job-detail-box">
          <div class="job-sec-text">我们希望你一周内到岗，团队长期在线协作。</div>
        </div>
      `);
      const result = readBossActivity(root);
      expect(result.activity).toBeUndefined();
      expect(result.labelsConsidered).toEqual([]);
    });

    it("returns undefined when there is no recruiter container at all", () => {
      const root = dom(`<div class="job-detail-box"></div>`);
      expect(readBossActivity(root).activity).toBeUndefined();
    });

    it("returns undefined for a null root rather than throwing", () => {
      expect(() => readBossActivity(null)).not.toThrow();
      expect(readBossActivity(null).activity).toBeUndefined();
    });

    it("prefers the semantic anchor over the class-based guess", () => {
      const root = dom(`
        <div class="boss-info"><span>半年前活跃</span></div>
        <div data-jobpilot-recruiter><span data-jobpilot-activity>在线</span></div>
      `);
      const result = readBossActivity(root);
      // The data attribute family is tried first and is authoritative.
      expect(result.activity?.recency).toBe("online");
    });
  });

  describe("conservative on conflict", () => {
    it("chooses the least active reading when labels disagree", () => {
      const root = dom(`
        <div class="boss-info">
          <span>在线</span>
          <span>30天前活跃</span>
        </div>
      `);
      const result = readBossActivity(root);
      // Optimism here would mean messaging a dormant recruiter.
      expect(result.activity?.recency).toBe("within_30_days");
      expect(result.activity?.online).toBe(false);
    });

    it("reports every label it considered, for diagnostics", () => {
      const root = dom(`
        <div class="boss-info"><span>在线</span><span>昨日活跃</span></div>
      `);
      const result = readBossActivity(root);
      expect(result.labelsConsidered.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("robustness", () => {
    it("ignores a long text block inside a recruiter container", () => {
      const root = dom(`
        <div class="boss-info">
          <p>${"很长的自我介绍文本".repeat(10)}</p>
          <span>今日活跃</span>
        </div>
      `);
      const result = readBossActivity(root);
      // The long paragraph must not be mistaken for an activity label.
      expect(result.activity?.label).toBe("今日活跃");
    });

    it("does not throw on an empty container", () => {
      const root = dom(`<div class="boss-info"></div>`);
      expect(() => readBossActivity(root)).not.toThrow();
    });

    it("handles an unrecognised label without inventing a reading", () => {
      const root = dom(`<div class="boss-info"><span>状态未知</span></div>`);
      expect(readBossActivity(root).activity).toBeUndefined();
    });

    it("reads a nested label several levels deep", () => {
      const root = dom(`
        <div class="job-boss-info">
          <div><div><em>刚刚活跃</em></div></div>
        </div>
      `);
      expect(readBossActivity(root).activity?.recency).toBe("today");
    });
  });
});
