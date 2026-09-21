/**
 * Unit tests for the BOSS chat readers and writers, driven by the synthetic
 * fixtures under `tests/fixtures/boss/`.
 *
 * ============================ HONESTY NOTICE ============================
 * The six chat fixtures (chat-*.html) mirror the REAL BOSS Zhipin chat DOM
 * captured on 2026-09-21 by the read-only recon harness, with sanitized
 * synthetic content. The modal/risk fixtures (success-modal, unknown-modal,
 * risk-page) remain hand-authored: no real capture exists for them yet.
 * =======================================================================
 *
 * The happy-dom `document.write` + doctype dance mirrors
 * `tests/integration/boss-harness.ts`: without an explicit doctype the fixtures
 * parse in quirks mode and happy-dom drops descendant text nodes, which would
 * make text assertions pass for the wrong reason.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  classifyModal,
  detectRiskBanner,
  findChatRoot,
  findEditor,
  findSendButton,
  isEditorEmpty,
  isFailedOutgoing,
  readChatIdentity,
  readEditorText,
  readOutgoingMessageBodies,
} from "../../../src/adapters/boss/communication/chat-reader";
import { writeEditorText } from "../../../src/adapters/boss/communication/write-editor";
import { countOutgoingMessages } from "../../../src/domain/communication/identity";

const CHAT_URL = "https://www.zhipin.com/web/geek/chat";

/** The message the fixtures treat as "the one the adapter sends". */
const PHRASE = "您好，我对这个职位很感兴趣，方便聊聊吗？";

/** Loads a fixture into a standards-mode happy-dom document. */
const load = (name: string): ParentNode => {
  const html = readFileSync(
    fileURLToPath(new URL(`../../fixtures/boss/${name}`, import.meta.url)),
    "utf8",
  );
  const window = new Window({ url: CHAT_URL });
  window.document.write(`<!doctype html>\n${html}`);
  return window.document as unknown as ParentNode;
};

describe("readChatIdentity", () => {
  it("reads the job id, title, company and recruiter from a conversation", () => {
    const identity = readChatIdentity(load("chat-conversation.html"));
    expect(identity).not.toBeNull();
    expect(identity?.jobIds).toEqual(["job-12345"]);
    expect(identity?.text).toContain("李女士");
    expect(identity?.text).toContain("后端开发工程师");
    expect(identity?.text).toContain("示例科技有限公司");
  });

  it("reads the DIFFERENT identity of a mismatched conversation", () => {
    const identity = readChatIdentity(load("chat-wrong-conversation.html"));
    expect(identity?.jobIds).toEqual(["job-99999"]);
    expect(identity?.text).toContain("市场推广专员");
    expect(identity?.text).not.toContain("后端开发工程师");
  });

  it("returns null when there is neither a chat root nor an editor", () => {
    expect(readChatIdentity(load("success-modal.html"))).toBeNull();
  });
});

describe("editor reading", () => {
  it("reports an empty editor as empty", () => {
    const root = load("chat-conversation.html");
    expect(isEditorEmpty(findEditor(root))).toBe(true);
  });

  it("reads an existing contenteditable draft", () => {
    const root = load("chat-with-draft.html");
    expect(readEditorText(findEditor(root))).toBe("我自己写了一半的草稿，请勿覆盖");
  });

  it("reads a textarea editor through .value", () => {
    const root = load("chat-textarea-editor.html");
    const editor = findEditor(root);
    expect(editor?.tagName).toBe("TEXTAREA");
    expect(readEditorText(editor)).toBe("");
  });

  it("is null-safe", () => {
    expect(readEditorText(null)).toBe("");
    expect(isEditorEmpty(null)).toBe(true);
  });
});

describe("writeEditorText", () => {
  it("writes into a contenteditable box and notifies listeners", () => {
    const root = load("chat-conversation.html");
    const editor = findEditor(root);
    expect(editor).not.toBeNull();
    if (editor === null) return;

    const seen: string[] = [];
    editor.addEventListener("input", () => seen.push("input"));
    editor.addEventListener("change", () => seen.push("change"));

    expect(writeEditorText(editor, PHRASE).ok).toBe(true);
    expect(readEditorText(editor)).toBe(PHRASE);
    expect(seen).toEqual(["input", "change"]);
  });

  it("writes into a textarea via the native value setter", () => {
    const root = load("chat-textarea-editor.html");
    const editor = findEditor(root);
    expect(editor).not.toBeNull();
    if (editor === null) return;

    const result = writeEditorText(editor, "直接写入测试");
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("written-via-native-setter");
    expect(readEditorText(editor)).toBe("直接写入测试");
  });

  it("refuses a detached editor instead of writing into the void", () => {
    const root = load("chat-conversation.html");
    const editor = findEditor(root);
    expect(editor).not.toBeNull();
    if (editor === null) return;

    const owner = editor.ownerDocument;
    editor.remove();
    expect(owner.contains(editor)).toBe(false);
    expect(writeEditorText(editor, PHRASE)).toEqual({
      ok: false,
      detail: "editor-detached",
    });
  });

  it("refuses null and empty text", () => {
    const root = load("chat-conversation.html");
    expect(writeEditorText(null, PHRASE).ok).toBe(false);
    expect(writeEditorText(findEditor(root), "").ok).toBe(false);
  });

  it("refuses a button, which also exposes a `value` property", () => {
    // A <button> has a string `value`, so a naive duck-type would treat it as an
    // editor and report a successful write into the send control.
    const root = load("chat-conversation.html");
    const button = findSendButton(root);
    expect(button).not.toBeNull();
    if (button === null) return;

    expect(writeEditorText(button, PHRASE)).toEqual({
      ok: false,
      detail: "editor-is-neither-value-control-nor-contenteditable",
    });
    expect(button.textContent).toBe("发送");
  });
});

describe("outgoing message counting", () => {
  it("collects only the delivered bubbles", () => {
    expect(readOutgoingMessageBodies(load("chat-conversation.html"))).toEqual([
      "您好，我对这个职位很感兴趣。",
    ]);
  });

  it("EXCLUDES a bubble marked 发送失败 from the bodies and the count", () => {
    const root = load("chat-message-failed.html");

    // The fixture really does contain two outgoing bubbles...
    expect(root.querySelectorAll(".message-item.item-myself").length).toBe(2);
    // ...and the second one really is flagged as failed.
    const bubbles = Array.from(root.querySelectorAll(".message-item.item-myself"));
    expect(bubbles.map((bubble) => isFailedOutgoing(bubble))).toEqual([false, true]);

    const bodies = readOutgoingMessageBodies(root);
    expect(bodies).toEqual(["您好，我对这个职位很感兴趣。"]);
    expect(bodies).not.toContain(PHRASE);
    expect(countOutgoingMessages(bodies, PHRASE)).toBe(0);
  });

  it("counts the sent message once it is present", () => {
    const bodies = readOutgoingMessageBodies(load("chat-message-sent.html"));
    expect(countOutgoingMessages(bodies, PHRASE)).toBe(1);
  });

  it("is empty-safe", () => {
    expect(countOutgoingMessages([], PHRASE)).toBe(0);
    expect(
      countOutgoingMessages(readOutgoingMessageBodies(load("success-modal.html")), PHRASE),
    ).toBe(0);
  });
});

describe("findSendButton", () => {
  it("finds the exactly-labelled 发送 control", () => {
    const button = findSendButton(load("chat-conversation.html"));
    expect(button).not.toBeNull();
    expect((button?.textContent ?? "").trim()).toBe("发送");
  });

  it("ignores a disabled button and a near-miss label", () => {
    const root = load("chat-conversation.html");
    const button = findSendButton(root);
    expect(button).not.toBeNull();
    if (button === null) return;

    button.setAttribute("disabled", "");
    expect(findSendButton(root)).toBeNull();

    button.removeAttribute("disabled");
    button.textContent = "发送中";
    expect(findSendButton(root)).toBeNull();

    button.textContent = "重新发送";
    expect(findSendButton(root)).toBeNull();

    button.textContent = "发送";
    expect(findSendButton(root)).not.toBeNull();
  });

  it("returns null when there is no conversation at all", () => {
    expect(findSendButton(load("unknown-modal.html"))).toBeNull();
  });
});

describe("classifyModal", () => {
  it("classifies the success dialog as success", () => {
    const result = classifyModal(load("success-modal.html"));
    expect(result.kind).toBe("success");
  });

  it("classifies an unrelated dialog as UNKNOWN, never as success", () => {
    const result = classifyModal(load("unknown-modal.html"));
    expect(result.kind).toBe("unknown");
  });

  it("downgrades a success-skin dialog that lacks the success text to unknown", () => {
    const root = load("success-modal.html");
    const dialog = root.querySelector("[data-jobpilot-modal='success']");
    expect(dialog).not.toBeNull();
    if (dialog === null) return;

    dialog.textContent = "实名认证后才可继续沟通";
    expect(classifyModal(root).kind).toBe("unknown");
  });

  it("treats a hidden success dialog as no dialog at all", () => {
    const root = load("success-modal.html");
    const dialog = root.querySelector("[data-jobpilot-modal='success']");
    expect(dialog).not.toBeNull();
    if (dialog === null) return;

    dialog.setAttribute("hidden", "");
    expect(classifyModal(root)).toEqual({ kind: "none" });
  });

  it("reports none on a page with no dialog", () => {
    expect(classifyModal(load("chat-conversation.html"))).toEqual({ kind: "none" });
  });
});

describe("detectRiskBanner", () => {
  it("detects the chat-scoped risk banner on the risk fixture", () => {
    const evidence = detectRiskBanner(load("risk-page.html"));
    expect(evidence).not.toBeNull();
    expect(evidence?.reason).toBe("risk-control");
  });

  it("stays quiet on a clean conversation", () => {
    expect(detectRiskBanner(load("chat-conversation.html"))).toBeNull();
  });
});

describe("chat root and editor discovery", () => {
  it("finds the conversation container", () => {
    expect(findChatRoot(load("chat-conversation.html"))).not.toBeNull();
  });

  it("returns null rather than falling back to the document", () => {
    expect(findChatRoot(load("unknown-modal.html"))).toBeNull();
    expect(findEditor(load("unknown-modal.html"))).toBeNull();
  });
});
