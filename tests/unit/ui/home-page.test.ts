/**
 * Home page three-step flow tests.
 *
 * The Home page is the product's core loop: ① 搜索岗位 → ② 选择职位 → ③ 批量投递.
 * These tests pin:
 *   - the three step titles render in order;
 *   - the scan button calls discover, the start button calls start;
 *   - checking a match row fires onToggleMatchSelect with that job id;
 *   - the discovery note renders under step ①.
 */
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { renderHomePage } from "../../../src/ui/pages/home";
import type { MatchRowView, UiCallbacks } from "../../../src/ui/view-model";

/** A happy-dom document in the DOM-lib type the renderers accept. */
const makeDoc = (): Document => new Window().document as unknown as Document;

/** Dispatches an event of the right realm for the given document. */
const fire = (doc: Document, target: EventTarget, type: string): void => {
  const view = doc.defaultView;
  if (view === null) throw new Error("document has no window");
  target.dispatchEvent(new view.Event(type, { bubbles: true }));
};

const match = (jobId: string, selected: boolean): MatchRowView => ({
  jobId,
  title: `职位 ${jobId}`,
  company: `公司 ${jobId}`,
  meta: "",
  score: 80,
  accepted: true,
  selected,
  reasons: [],
});

const callbacksWith = (overrides: Partial<UiCallbacks> = {}): UiCallbacks => ({
  discover: () => {},
  start: () => {},
  pause: () => {},
  resume: () => {},
  recheck: () => {},
  skipCurrent: () => {},
  stop: () => {},
  setCollapsed: () => {},
  ...overrides,
});

describe("renderHomePage three-step flow", () => {
  it("renders the three step titles in order", () => {
    const doc = makeDoc();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith(),
      matches: [match("a", true)],
    });

    const titles = Array.from(page.querySelectorAll(".jobpilot-step-title")).map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(["搜索岗位", "选择职位", "批量投递"]);

    const badges = Array.from(page.querySelectorAll(".jobpilot-step-badge")).map(
      (node) => node.textContent,
    );
    expect(badges).toEqual(["①", "②", "③"]);
  });

  it("hides step ② when there are no matches", () => {
    const doc = makeDoc();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith(),
      matches: [],
    });

    const titles = Array.from(page.querySelectorAll(".jobpilot-step-title")).map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(["搜索岗位", "批量投递"]);
  });

  it("scan button calls discover and start button calls start", () => {
    const doc = makeDoc();
    const discover = vi.fn();
    const start = vi.fn();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith({ discover, start }),
    });

    const scanBtn = page.querySelector('button[data-action="discover-jobs"]');
    if (scanBtn === null) throw new Error("scan button missing");
    fire(doc, scanBtn, "click");
    expect(discover).toHaveBeenCalledTimes(1);

    const startBtn = page.querySelector('button[data-action="start-batch"]');
    if (startBtn === null) throw new Error("start button missing");
    fire(doc, startBtn, "click");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("fires onToggleMatchSelect with the job id when a checkbox changes", () => {
    const doc = makeDoc();
    const onToggleMatchSelect = vi.fn();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith({ onToggleMatchSelect }),
      matches: [match("job-a", true), match("job-b", false)],
    });

    const boxes = Array.from(page.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);

    fire(doc, boxes[1] as HTMLInputElement, "change");
    expect(onToggleMatchSelect).toHaveBeenCalledTimes(1);
    expect(onToggleMatchSelect).toHaveBeenCalledWith("job-b");
  });

  it("shows the selected count and the discovery note", () => {
    const doc = makeDoc();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith(),
      matches: [match("job-a", true), match("job-b", false)],
      discoveryNote: "共找到 2 个职位，1 个符合你的意向，已默认勾选。",
    });

    expect(page.textContent).toContain("已选择 1 个职位");
    expect(page.textContent).toContain("共找到 2 个职位");
  });
});
