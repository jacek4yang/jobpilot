/**
 * Floating blocking modal tests.
 *
 * The modal is the surface for human-verification states (CAPTCHA, risk
 * control, login expiry, ...). It must render the title as the largest text,
 * the plain-language reason as the body, and exactly two wired buttons —
 * with no close affordance, because a blocked state only clears when the
 * operator re-checks or stops.
 */
// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { createBlockingModal, isBlockingModalKind } from "../../../src/ui/modal";

/** A happy-dom document in the DOM-lib type the renderers accept. */
const makeDoc = (): Document => new Window().document as unknown as Document;

/** Dispatches an event of the right realm for the given document. */
const fire = (doc: Document, target: EventTarget, type: string, init: EventInit = {}): void => {
  const view = doc.defaultView;
  if (view === null) throw new Error("document has no window");
  target.dispatchEvent(new view.Event(type, { bubbles: true, ...init }));
};

const createWith = (overrides: Partial<Parameters<typeof createBlockingModal>[1]> = {}) =>
  createBlockingModal(makeDoc(), {
    title: "需要你的处理",
    body: "检测到验证码，请在页面中手动完成验证后再继续",
    onRecheck: () => {},
    onStop: () => {},
    ...overrides,
  });

describe("createBlockingModal", () => {
  it("renders title, body and both action buttons", () => {
    const modal = createWith();
    const root = modal.el;

    expect(root.className).toBe("jobpilot-modal-overlay");
    expect(root.getAttribute("role")).toBe("alertdialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(root.getAttribute("aria-label")).toBe("需要你的处理");

    expect(root.querySelector(".jobpilot-modal-title")?.textContent).toBe("需要你的处理");
    expect(root.querySelector(".jobpilot-modal-body")?.textContent).toContain("验证码");

    const recheck = root.querySelector('button[data-action="recheck"]');
    const stop = root.querySelector('button[data-action="stop"]');
    expect(recheck?.textContent).toBe("重新检查页面");
    expect(recheck?.getAttribute("data-variant")).toBe("primary");
    expect(stop?.textContent).toBe("停止本次任务");
    expect(stop?.getAttribute("data-variant")).toBe("danger");
  });

  it("invokes onRecheck / onStop when the buttons are clicked", () => {
    const onRecheck = vi.fn();
    const onStop = vi.fn();
    const doc = makeDoc();
    const modal = createWith({ onRecheck, onStop });
    doc.body.append(modal.el);

    const recheck = modal.el.querySelector('button[data-action="recheck"]');
    const stop = modal.el.querySelector('button[data-action="stop"]');
    if (recheck === null || stop === null) throw new Error("modal buttons missing");

    fire(doc, recheck, "click");
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    fire(doc, stop, "click");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("offers no close affordance", () => {
    const modal = createWith();

    expect(modal.el.querySelectorAll("button")).toHaveLength(2);
    expect(modal.el.querySelector('[data-action="close"]')).toBeNull();
  });

  it("treats Enter on the overlay as a recheck request", () => {
    const onRecheck = vi.fn();
    const doc = makeDoc();
    const modal = createWith({ onRecheck });
    doc.body.append(modal.el);

    const view = doc.defaultView;
    if (view === null) throw new Error("document has no window");
    modal.el.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("lets a focused button keep its own Enter behaviour (no double recheck)", () => {
    const onRecheck = vi.fn();
    const onStop = vi.fn();
    const doc = makeDoc();
    const modal = createWith({ onRecheck, onStop });
    doc.body.append(modal.el);

    const stop = modal.el.querySelector('button[data-action="stop"]');
    if (stop === null) throw new Error("stop button missing");
    const view = doc.defaultView;
    if (view === null) throw new Error("document has no window");
    stop.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onRecheck).not.toHaveBeenCalled();
  });

  it("close() removes the element from the DOM", () => {
    const doc = makeDoc();
    const modal = createWith();
    doc.body.append(modal.el);
    expect(doc.querySelector(".jobpilot-modal-overlay")).not.toBeNull();

    modal.close();
    expect(doc.querySelector(".jobpilot-modal-overlay")).toBeNull();
  });
});

describe("isBlockingModalKind", () => {
  it("accepts the human-verification kinds", () => {
    for (const kind of [
      "captcha",
      "risk-control",
      "login-expired",
      "unknown-dom",
      "rate-limited",
      "needs-human-click",
    ]) {
      expect(isBlockingModalKind(kind)).toBe(true);
    }
  });

  it("rejects user-initiated and bookkeeping pauses", () => {
    for (const kind of [
      "user",
      "selector-missing",
      "ambiguous-state",
      "session-limit",
      "watchdog",
      "page-changed",
    ]) {
      expect(isBlockingModalKind(kind)).toBe(false);
    }
  });
});
