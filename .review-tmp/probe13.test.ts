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

describe("probe13", () => {
  it("user types between prepare and dispatch", async () => {
    const root = load("chat-conversation.html");
    const doc = root as unknown as Document;
    const editor = doc.querySelector("[data-jobpilot-editor]")!;
    let clicks = 0;
    doc.querySelector("[data-jobpilot-action='send']")!.addEventListener("click", () => clicks++);

    const action = createCommunicationAction({ document: root, clock: { now: () => 1 }, logger });
    const intent = createIntent({
      id: "i", jobId: asJobId("job-12345"), sourceUrl: "s",
      messageText: "AUTO MESSAGE", outgoingBaseline: 0, now: 0, ttlMs: 1e15,
      expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
    });
    const prep = await action.prepareMessage(intent);
    console.log("PREPARE:", prep.kind);
    // User types over it:
    editor.textContent = "MY OWN DRAFT";
    const disp = await action.dispatchSend(intent);
    console.log("DISPATCH:", JSON.stringify(disp), "clicks:", clicks);
    console.log("editor preserved:", JSON.stringify(editor.textContent));
    expect(true).toBe(true);

    // And the load-bearing case: prepareMessage against a PRE-EXISTING draft.
    const root2 = load("chat-with-draft.html");
    const doc2 = root2 as unknown as Document;
    const editor2 = doc2.querySelector("[data-jobpilot-editor]")!;
    const before = editor2.textContent;
    const action2 = createCommunicationAction({ document: root2, clock: { now: () => 1 }, logger });
    const prep2 = await action2.prepareMessage(intent);
    console.log("PREPARE-ON-DRAFT:", JSON.stringify(prep2));
    console.log("draft before:", JSON.stringify(before), "after:", JSON.stringify(editor2.textContent));
  });
});
