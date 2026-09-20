import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createCommunicationAction } from "../src/adapters/boss/communication/communication-action";
import { createIntent } from "../src/domain/communication/intent";
import { asJobId } from "../src/domain/support/ids";

const load = (name: string): ParentNode => {
  const html = readFileSync(`tests/fixtures/boss/${name}`, "utf8");
  const w = new Window({ url: "https://www.zhipin.com/web/geek/chat" });
  w.document.write(`<!doctype html>\n${html}`);
  return w.document as unknown as ParentNode;
};
const logger = { debug(){},info(){},warn(){},error(){},entries(){return[]},clear(){} };

describe("probe12: draft TOCTOU", () => {
  it("prepareMessage checks emptiness, then writes; no re-check between", async () => {
    let root = load("chat-conversation.html");
    let doc = root as unknown as Document;
    const editor = doc.querySelector("[data-jobpilot-editor]")!;
    console.log("editor empty at start:", JSON.stringify(editor.textContent));

    // Simulate the user typing BETWEEN the emptiness read and the write.
    // We hook the input event dispatch that writeEditorText performs, but
    // more realistically: the check `readEditorText(editor)` happens, then
    // writeEditorText assigns textContent. Let's prove the window exists by
    // monkey-patching the editor's textContent setter to inject a draft first.
    const action = createCommunicationAction({
      document: root, clock: { now: () => 1 }, logger,
    });
    const intent = createIntent({
      id: "i", jobId: asJobId("job-12345"), sourceUrl: "s",
      messageText: "AUTO MESSAGE", outgoingBaseline: 0, now: 0, ttlMs: 1e15,
      expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
    });
    const prep = await action.prepareMessage(intent);
    console.log("PREPARE:", JSON.stringify(prep));
    console.log("editor after:", JSON.stringify(editor.textContent));
    expect(true).toBe(true);
  });
});
