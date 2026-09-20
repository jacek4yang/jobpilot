import { describe, expect, it } from "vitest";
import { createCommunicationAction } from "../src/adapters/boss/communication/communication-action";
import { createCommunicationRunner } from "../src/application/communication-runner";
import { createIntent } from "../src/domain/communication/intent";
import { asJobId } from "../src/domain/support/ids";
import { createNullLogger } from "../src/infrastructure/logging/logger";

const chatHtml = `
<div class="chat-content">
  <div class="chat-header">后端开发工程师 示例科技有限公司</div>
  <div class="chat-editor" contenteditable="true"></div>
  <button class="send-btn">发送</button>
</div>`;

describe("probe2: real runner x real adapter", () => {
  it("can never send, because runner marks send-attempted before the click", async () => {
    const doc = document.implementation.createHTMLDocument("t");
    doc.body.innerHTML = chatHtml;
    let clicks = 0;
    const btn = doc.querySelector("button.send-btn")!;
    btn.addEventListener("click", () => { clicks += 1; });

    const action = createCommunicationAction({
      document: doc, clock: { now: () => 1_700_000_000_000 }, logger: createNullLogger(),
    });
    const phases: string[] = [];
    const runner = createCommunicationRunner({
      action, logger: createNullLogger(), clock: { now: () => 1_700_000_000_000 },
      persistIntent: async (i) => { phases.push(i.phase); },
      clearIntent: async () => { phases.push("CLEARED"); },
    });
    const intent = createIntent({
      id: "i", jobId: asJobId("j"), sourceUrl: "s",
      messageText: "hello", outgoingBaseline: 0, now: 0, ttlMs: 1_700_000_000_000,
      expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
    });
    const outcome = await runner.run(intent);
    console.log("PHASES:", JSON.stringify(phases));
    console.log("OUTCOME:", JSON.stringify(outcome));
    console.log("CLICK COUNT:", clicks);
    expect(false).toBe(true);
  });
});
