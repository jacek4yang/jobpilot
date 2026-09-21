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
// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
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

  it("hides the run log entirely before anything has run", () => {
    const doc = makeDoc();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith(),
    });

    expect(page.querySelector(".jobpilot-step-run-log")).toBeNull();
    expect(page.textContent).not.toContain("本次运行记录");
  });

  it("renders the operator run log newest-first under the steps", () => {
    const doc = makeDoc();
    const page = renderHomePage(doc, {
      decisions: [],
      callbacks: callbacksWith(),
      runLog: [
        { time: "10:00:01", text: "开始投递" },
        { time: "10:00:00", text: "开始扫描职位" },
      ],
    });

    const logRows = Array.from(page.querySelectorAll(".jobpilot-step-run-log-row"));
    expect(logRows).toHaveLength(2);
    expect(logRows[0]?.textContent).toBe("10:00:01开始投递");
    expect(logRows[1]?.textContent).toBe("10:00:00开始扫描职位");
    // The log appears after the three-step cards, keeping the flow calm.
    const steps = page.querySelector(".jobpilot-section");
    expect(steps?.querySelector(".jobpilot-step-run-log")).not.toBeNull();
  });

  it("updates in place without losing checkbox focus or list scroll", async () => {
    const doc = makeDoc();
    const callbacks = callbacksWith();
    const first = renderHomePage(doc, {
      decisions: [],
      callbacks,
      matches: [match("job-a", true), match("job-b", true)],
    });
    doc.body.append(first);

    const list = first.querySelector<HTMLElement>(".jobpilot-step-match-list");
    const checkbox = first.querySelector<HTMLInputElement>('input[data-job-id="job-b"]');
    if (list === null || checkbox === null) throw new Error("selection controls missing");
    list.scrollTop = 37;
    checkbox.focus();

    const second = renderHomePage(doc, {
      decisions: [],
      callbacks,
      discoveryNote: "异步状态已更新",
      matches: [match("job-a", false), match("job-b", true)],
    });
    await nextTick();

    expect(second).toBe(first);
    expect(first.querySelector('input[data-job-id="job-b"]')).toBe(checkbox);
    expect(doc.activeElement).toBe(checkbox);
    expect(list.scrollTop).toBe(37);
    expect(first.querySelector<HTMLInputElement>('input[data-job-id="job-a"]')?.checked).toBe(
      false,
    );
  });
});
