/**
 * Unit tests for the BOSS communication action.
 *
 * ============================ HONESTY NOTICE ============================
 * Everything asserted here runs against the synthetic fixtures under
 * `tests/fixtures/boss/`, which were hand-authored to match our own selectors.
 * These tests prove the fail-closed CONTROL FLOW is implemented. They are not
 * evidence that any of it works on the real BOSS Zhipin site, which was never
 * inspected.
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

/** Moves an intent into the only phase from which a send is legal. */
const prepared = (intent: CommunicationIntent): CommunicationIntent => ({
  ...intent,
  phase: "prepared",
});

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
  it("refuses when canClickSend is false, before touching the DOM", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);

    // An armed (not prepared) intent is not sendable.
    const armed = intentFor();
    const refused = await action.dispatchSend(armed);
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" ? refused.detail : "").toContain("armed");

    // A send-attempted intent must NEVER be sendable again. This is the
    // never-send-twice invariant, asserted at the adapter boundary.
    const attempted: CommunicationIntent = {
      ...prepared(armed),
      phase: "send-attempted",
      sendAttemptedAt: NOW,
    };
    const second = await action.dispatchSend(attempted);
    expect(second.kind).toBe("refused");

    // ...and the editor was never written to by either refusal.
    expect(readEditorText(findEditor(root))).toBe("");
  });

  it("dispatches exactly one click for a prepared, matching intent", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);
    const intent = prepared(intentFor());

    expect((await action.prepareMessage(intent)).kind).toBe("ready");

    const button = root.querySelector("[data-jobpilot-action='send']");
    expect(button).not.toBeNull();
    let clicks = 0;
    button?.addEventListener("click", () => {
      clicks += 1;
    });

    expect(await action.dispatchSend(intent)).toEqual({ kind: "dispatched" });
    expect(clicks).toBe(1);
  });

  it("blocks on a risk page", async () => {
    const result = await actionFor(load("risk-page.html")).dispatchSend(prepared(intentFor()));
    expect(result.kind === "blocked" ? result.reason : "").toBe("captcha");
  });

  it("refuses to send when the editor text is not the intended text", async () => {
    const root = load("chat-conversation.html");
    const action = actionFor(root);
    const intent = prepared(intentFor());

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
    expect(phrases[0]).toBe(PHRASE);
  });

  it("reads the current chat identity", () => {
    expect(actionFor(load("chat-conversation.html")).readCurrentChat()?.jobIds).toEqual([
      "job-12345",
    ]);
  });
});
