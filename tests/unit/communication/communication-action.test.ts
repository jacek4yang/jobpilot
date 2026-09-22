/**
 * Unit tests for the BOSS communication action.
 *
 * ============================ HONESTY NOTICE ============================
 * Everything asserted here runs against the synthetic fixtures under
 * `tests/fixtures/boss/`. The six chat fixtures mirror the REAL BOSS Zhipin
 * chat DOM captured on 2026-09-21 (sanitized content); the modal/risk fixtures
 * remain hand-authored. Live-site messaging is still UNVERIFIED and must not
 * be described as working.
 * =======================================================================
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { findEditor, readEditorText } from "../../../src/adapters/boss/communication/chat-reader";
import {
  createCommunicationAction,
  findActiveDetailRoot,
  readCommonPhrases,
} from "../../../src/adapters/boss/communication/communication-action";
import { type CommunicationIntent, createIntent } from "../../../src/domain/communication/intent";
import { asJobId } from "../../../src/domain/support/ids";
import type { Logger } from "../../../src/ports/logger";

const CHAT_URL = "https://www.zhipin.com/web/geek/chat";
const PHRASE = "您好，我对这个职位很感兴趣，方便聊聊吗？";
const NOW = 1_704_067_200_000;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: () => [],
  clear: () => {},
};

const load = (name: string): ParentNode => {
  const html = readFileSync(
    fileURLToPath(new URL(`../../fixtures/boss/${name}`, import.meta.url)),
    "utf8",
  );
  const window = new Window({ url: CHAT_URL });
  window.document.write(`<!doctype html>\n${html}`);
  return window.document as unknown as ParentNode;
};

const actionFor = (root: ParentNode) =>
  createCommunicationAction({ document: root, clock: { now: () => NOW }, logger: silentLogger });

/** An intent aimed at the job the conversation fixtures describe. */
const intentFor = (overrides: Partial<Parameters<typeof createIntent>[0]> = {}) =>
  createIntent({
    id: "intent-1",
    jobId: asJobId("job-12345"),
    sourceUrl: "https://www.zhipin.com/job_detail/job-12345.html",
    messageText: PHRASE,
    outgoingBaseline: 0,
    now: NOW,
    ttlMs: 60_000,
    expectedJobTitle: "后端开发工程师",
    expectedCompany: "示例科技有限公司",
    ...overrides,
  });

/**
 * Moves an intent into the phase the runner actually hands to the adapter:
 * committed to a single send (`send-attempted`), with no click recorded yet.
 *
 * Note this is NOT `prepared`. The runner stamps the point of no return before
 * calling dispatchSend, so a guard requiring `prepared` would refuse every real
 * send — the contract defect these tests now pin down.
 */
const committed = (intent: CommunicationIntent): CommunicationIntent => ({
  ...intent,
  phase: "send-attempted",
  sendAttemptedAt: NOW,
});

/** An intent still sitting in `prepared`, used to prove it is not sendable. */
const preparedOnly = (intent: CommunicationIntent): CommunicationIntent => ({
  ...intent,
  phase: "prepared",
});

/** Attaches a counting click listener; the returned reader reports the total. */
const countClicksOn = (element: Element): (() => number) => {
  let clicks = 0;
  element.addEventListener("click", () => {
    clicks += 1;
  });
  return () => clicks;
};

describe("findCommunicateButton", () => {
  it("finds 立即沟通 inside an active job-detail root", () => {
    const root = load("success-modal.html");
    const found = actionFor(root).findCommunicateButton();
    expect(found).not.toBeNull();
    expect(found?.element.textContent?.trim()).toBe("立即沟通");
  });

  it("returns null when there is no detail root, rather than searching the page", () => {
    expect(actionFor(load("chat-conversation.html")).findCommunicateButton()).toBeNull();
  });

  it("ignores a detail root that is hidden", () => {
    const root = load("success-modal.html");
    const detail = root.querySelector("[data-jobpilot-detail]");
    expect(detail).not.toBeNull();
    detail?.setAttribute("hidden", "");
    expect(findActiveDetailRoot(root)).toBeNull();
  });
});

describe("openConversation", () => {
  const replaceWithFixture = (root: ParentNode, name: string): void => {
    const html = readFileSync(
      fileURLToPath(new URL(`../../fixtures/boss/${name}`, import.meta.url)),
      "utf8",
    );
    const document = root as Document;
    document.body.innerHTML = html;
  };

  it("never clicks the control; waits for the operator's click and proceeds when the chat appears", async () => {
    const root = load("job-detail.html");
    const button = root.querySelector("button");
    expect(button).not.toBeNull();
    let clicks = 0;
    button?.addEventListener("click", () => {
      clicks += 1;
    });

    // Simulate the operator: the conversation appears only after JobPilot has
    // started polling — the identity must be picked up on a LATER attempt,
    // without any synthetic click.
    let polls = 0;
    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 3,
      scheduler: (run) => {
        polls += 1;
        if (polls === 2) replaceWithFixture(root, "chat-conversation.html");
        run();
      },
    });

    expect(result.kind).toBe("ready");
    expect(clicks).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("highlights the exact control and scrolls it into view while waiting", async () => {
    const root = load("job-detail.html");
    const button = root.querySelector("button");
    expect(button).not.toBeNull();
    if (button === null) throw new Error("fixture has no control");
    let scrolled = 0;
    button.scrollIntoView = (() => {
      scrolled += 1;
    }) as typeof button.scrollIntoView;
    const clicks = countClicksOn(button);

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 1,
    });

    expect(result.kind).toBe("needs-human-click");
    expect(clicks()).toBe(0);
    // happy-dom serialises the shorthand in its own order, so assert the
    // parsed longhands — those are what the operator's browser renders.
    expect(button.style.outlineWidth).toBe("3px");
    expect(button.style.outlineStyle).toBe("solid");
    expect(button.style.outlineColor).toBe("#cf5477");
    expect(button.style.outlineOffset).toBe("2px");
    expect(scrolled).toBe(1);
  });

  it("fails closed with an actionable detail when no click arrives before the budget runs out", async () => {
    const root = load("job-detail.html");
    const button = root.querySelector("button");
    expect(button).not.toBeNull();
    if (button === null) throw new Error("fixture has no control");
    const clicks = countClicksOn(button);

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 3,
      scheduler: (run) => run(),
    });

    expect(result.kind).toBe("needs-human-click");
    expect(result).toEqual({
      kind: "needs-human-click",
      detail: "等待超时：没有检测到对话出现。请点击职位详情里的「立即沟通」按钮，然后点「继续」。",
    });
    expect(clicks()).toBe(0);
  });

  it("fails closed when the opened conversation belongs to another job", async () => {
    const root = load("job-detail.html");
    let polls = 0;
    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 2,
      scheduler: (run) => {
        polls += 1;
        if (polls === 1) replaceWithFixture(root, "chat-wrong-conversation.html");
        run();
      },
    });

    expect(result.kind).toBe("chat-mismatch");
  });

  const PLATFORM_DIALOG = `
    <div class="dialog-container success" role="dialog" data-jobpilot-modal="success">
      <div class="dialog__body">已向BOSS发送消息，请留意对方回复。</div>
      <div class="dialog__footer">
        <button type="button" data-jobpilot-action="stay">留在此页</button>
        <button type="button" data-jobpilot-action="continue">继续沟通</button>
      </div>
    </div>`;

  const injectPlatformDialog = (root: ParentNode, html: string): void => {
    (root as Document).body.insertAdjacentHTML("beforeend", html);
  };

  it("accepts the platform success dialog, clicks 留在此页 once, and reports platform-dialog-confirmed", async () => {
    const root = load("job-detail.html");
    const clicks = { stay: 0, jump: 0 };
    let polls = 0;

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 4,
      scheduler: (run) => {
        polls += 1;
        if (polls === 1) {
          // The platform answers the operator's click with its own dialog on
          // the listing tab; the conversation opened in another tab.
          injectPlatformDialog(root, PLATFORM_DIALOG);
          const document = root as Document;
          document.querySelector("[data-jobpilot-action='stay']")?.addEventListener("click", () => {
            clicks.stay += 1;
          });
          document
            .querySelector("[data-jobpilot-action='continue']")
            ?.addEventListener("click", () => {
              clicks.jump += 1;
            });
        }
        run();
      },
    });

    expect(result).toEqual({
      kind: "platform-dialog-confirmed",
      evidence: "platform success dialog observed and dismissed",
    });
    // Exactly one synthetic click, on 留在此页 only. 继续沟通 would jump to
    // the chat tab and must never be clicked.
    expect(clicks.stay).toBe(1);
    expect(clicks.jump).toBe(0);
  });

  it("keeps waiting when the dialog has no 留在此页 control, then blocks with an actionable message", async () => {
    const root = load("job-detail.html");
    const variant = PLATFORM_DIALOG.replace(
      '<button type="button" data-jobpilot-action="stay">留在此页</button>',
      "",
    );
    let polls = 0;

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 3,
      scheduler: (run) => {
        polls += 1;
        if (polls === 1) injectPlatformDialog(root, variant);
        run();
      },
    });

    // A dialog variant we cannot dismiss is a hard stop, not a success.
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("ambiguous-state");
      expect(result.evidence).toContain("留在此页");
    }
  });

  it("prefers a same-document chat identity over the platform dialog", async () => {
    const root = load("job-detail.html");
    let polls = 0;

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 3,
      scheduler: (run) => {
        polls += 1;
        if (polls === 1) {
          // Both outcomes present in the same probe: identity wins.
          replaceWithFixture(root, "chat-conversation.html");
          injectPlatformDialog(root, PLATFORM_DIALOG);
        }
        run();
      },
    });

    expect(result.kind).toBe("ready");
  });

  it("never treats a dialog without the 已向BOSS发送消息 text as the platform success dialog", async () => {
    // unknown-modal is a job-detail with the exact 立即沟通 control plus an
    // unrelated 实名认证 dialog and no chat: the dialog lacks the success
    // token, so the wait must end as needs-human-click, not dialog-confirmed.
    const root = load("unknown-modal.html");
    const button = root.querySelector("[data-jobpilot-action='apply']");
    expect(button).not.toBeNull();
    if (button === null) throw new Error("fixture has no control");
    const clicks = countClicksOn(button);

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 1,
    });

    expect(result.kind).toBe("needs-human-click");
    expect(clicks()).toBe(0);
  });

  it("blocks when the active detail has no exact 立即沟通 control, with no fallback click", async () => {
    const window = new Window({ url: CHAT_URL });
    window.document.write(`<!doctype html>
      <html>
        <body>
          <main data-jobpilot-detail>
            <button type="button" aria-label="收藏">收藏</button>
          </main>
        </body>
      </html>`);
    const root = window.document as unknown as ParentNode;
    const wrongControl = root.querySelector("button");
    expect(wrongControl).not.toBeNull();
    if (wrongControl === null) throw new Error("fixture has no control");
    const clicks = countClicksOn(wrongControl);

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 1,
    });

    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.reason : "").toBe("selector-missing");
    expect(clicks()).toBe(0);
  });

  it("never treats an unrelated dialog as an opened conversation", async () => {
    // unknown-modal is a job-detail with the exact control plus an unrelated
    // dialog and no chat: the wait must time out as needs-human-click, and no
    // synthetic click may have fired — the dialog is not send evidence.
    const root = load("unknown-modal.html");
    const button = root.querySelector("[data-jobpilot-action='apply']");
    expect(button).not.toBeNull();
    if (button === null) throw new Error("fixture has no control");
    const clicks = countClicksOn(button);

    const result = await actionFor(root).openConversation(intentFor(), {
      maxAttempts: 1,
    });

    expect(result.kind).toBe("needs-human-click");
    expect(clicks()).toBe(0);
  });
});

describe("prepareMessage", () => {
  it("reports a draft and leaves the editor byte-for-byte untouched", async () => {
    const root = load("chat-with-draft.html");
    const before = readEditorText(findEditor(root));

    const result = await actionFor(root).prepareMessage(intentFor());

    expect(result.kind).toBe("draft-present");
    expect(result.kind === "draft-present" ? result.text : "").toBe(
      "我自己写了一半的草稿，请勿覆盖",
    );
    expect(readEditorText(findEditor(root))).toBe(before);
  });

  it("writes the message and verifies it landed", async () => {
    const root = load("chat-conversation.html");
    const result = await actionFor(root).prepareMessage(intentFor());

    expect(result).toEqual({ kind: "ready", text: PHRASE });
    expect(readEditorText(findEditor(root))).toBe(PHRASE);
  });

  it("refuses a conversation whose identity does not match", async () => {
    const result = await actionFor(load("chat-wrong-conversation.html")).prepareMessage(
      intentFor(),
    );
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.reason : "").toBe("ambiguous-state");
  });

  it("blocks on a risk page instead of typing", async () => {
    const root = load("risk-page.html");
    const result = await actionFor(root).prepareMessage(intentFor());
    expect(result.kind === "blocked" ? result.reason : "").toBe("captcha");
    expect(readEditorText(findEditor(root))).toBe("");
  });

  it("blocks when there is no conversation surface at all", async () => {
    const result = await actionFor(load("unknown-modal.html")).prepareMessage(intentFor());
    expect(result.kind === "blocked" ? result.reason : "").toBe("unknown-dom");
  });

  it("refuses an empty message rather than typing nothing", async () => {
    const result = await actionFor(load("chat-conversation.html")).prepareMessage(
      intentFor({ messageText: "   " }),
    );
    expect(result.kind === "blocked" ? result.reason : "").toBe("ambiguous-state");
  });
});

describe("dispatchSend", () => {
  it("refuses an intent that has not been committed, before touching the DOM", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);
    // `armed` is the initial phase: nothing verified, nothing committed.
    const refused = await action.dispatchSend(intentFor());
    expect(refused.kind).toBe("refused");
    // `prepared` alone is also insufficient. The runner must have committed
    // the transaction by recording the point of no return first.
    const notCommitted = await action.dispatchSend(preparedOnly(intentFor()));
    expect(notCommitted.kind).toBe("refused");
    // The editor was never written to by either refusal.
    expect(readEditorText(findEditor(root))).toBe("");
  });

  it("refuses when a click has already been dispatched", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);

    // The never-send-twice invariant at the adapter boundary: once
    // `clickDispatched` is recorded, no further click is possible.
    const alreadyClicked: CommunicationIntent = {
      ...committed(intentFor()),
      clickDispatched: NOW,
    };

    const second = await action.dispatchSend(alreadyClicked);
    expect(second.kind).toBe("refused");
    expect(second.kind === "refused" ? second.detail : "").toContain("already");
  });

  it("dispatches exactly one click for a committed, matching intent", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);
    const intent = committed(intentFor());

    expect((await action.prepareMessage(intent)).kind).toBe("ready");

    const button = root.querySelector(".btn-send");
    expect(button).not.toBeNull();
    let clicks = 0;
    button?.addEventListener("click", () => {
      clicks += 1;
    });

    expect(await action.dispatchSend(intent)).toEqual({ kind: "dispatched" });
    expect(clicks).toBe(1);
  });

  it("blocks on a risk page", async () => {
    const result = await actionFor(load("risk-page.html")).dispatchSend(committed(intentFor()));
    expect(result.kind === "blocked" ? result.reason : "").toBe("captcha");
  });

  it("refuses to send when the editor text is not the intended text", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);
    const intent = committed(intentFor());

    // Someone typed something else after prepare.
    const editor = findEditor(root);
    expect(editor).not.toBeNull();
    if (editor !== null) editor.textContent = "用户改过的内容";

    const result = await action.dispatchSend(intent);
    expect(result.kind === "blocked" ? result.reason : "").toBe("ambiguous-state");
  });
});

describe("observeSend", () => {
  it("reports observed only when the count strictly exceeds the baseline", async () => {
    const action = actionFor(load("chat-message-sent.html"));
    const intent = intentFor();

    const observed = await action.observeSend(intent, 0, { maxAttempts: 1 });
    expect(observed.kind).toBe("observed");
    expect(observed.kind === "observed" ? observed.count : 0).toBe(1);

    // Equal to the baseline is NOT evidence of a new message.
    const notNew = await action.observeSend(intent, 1, { maxAttempts: 1 });
    expect(notNew.kind).toBe("unobserved");
  });

  it("never reports observed for a message that failed to send", async () => {
    const action = actionFor(load("chat-message-failed.html"));
    const result = await action.observeSend(intentFor(), 0, { maxAttempts: 1 });
    expect(result.kind).toBe("unobserved");
    expect(result.kind === "unobserved" ? result.detail : "").toContain("baseline 0");
  });

  it("never reports observed when the conversation shows nothing", async () => {
    const action = actionFor(load("chat-conversation.html"));
    expect((await action.observeSend(intentFor(), 0, { maxAttempts: 1 })).kind).toBe("unobserved");
  });

  it("gives up on an already-aborted signal instead of looping", async () => {
    const action = actionFor(load("chat-message-sent.html"));
    const controller = new AbortController();
    controller.abort();

    let polls = 0;
    const result = await action.observeSend(intentFor(), 5, {
      signal: controller.signal,
      maxAttempts: 5,
      scheduler: (run) => {
        polls += 1;
        run();
      },
    });
    expect(result.kind).toBe("unobserved");
    expect(polls).toBe(0);
  });

  it("blocks on a risk page", async () => {
    const result = await actionFor(load("risk-page.html")).observeSend(intentFor(), 0, {
      maxAttempts: 1,
    });
    expect(result.kind === "blocked" ? result.reason : "").toBe("captcha");
  });
});

describe("modal and block classification", () => {
  it("classifies the success dialog as success", () => {
    expect(actionFor(load("success-modal.html")).classifyModal().kind).toBe("success");
  });

  it("classifies an unrelated dialog as unknown", () => {
    expect(actionFor(load("unknown-modal.html")).classifyModal().kind).toBe("unknown");
  });

  it("reports no block on a clean conversation", () => {
    expect(actionFor(load("chat-conversation.html")).detectBlock()).toBeNull();
  });

  it("reports the page guard on a risk page", () => {
    const block = actionFor(load("risk-page.html")).detectBlock();
    expect(block?.reason).toBe("captcha");
  });
});

describe("readers and helpers", () => {
  it("reads the editor and the outgoing count", () => {
    const action = actionFor(load("chat-message-sent.html"));
    expect(action.readEditor()).toBe("");
    expect(action.outgoingCount(PHRASE)).toBe(1);
  });

  it("returns null from readEditor when there is no editor", () => {
    expect(actionFor(load("unknown-modal.html")).readEditor()).toBeNull();
  });

  it("lists the common phrases in document order", () => {
    const phrases = readCommonPhrases(load("chat-conversation.html"));
    expect(phrases).toHaveLength(3);
    // The fixture mirrors the real capture's phrase panel: its first item is
    // the short greeting, not the full PHRASE the adapter sends.
    expect(phrases[0]).toBe("您好，我对这个职位很感兴趣。");
  });

  it("reads the current chat identity", () => {
    expect(actionFor(load("chat-conversation.html")).readCurrentChat()?.jobIds).toEqual([
      "job-12345",
    ]);
  });
});
