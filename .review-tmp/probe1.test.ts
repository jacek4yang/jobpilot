import { describe, expect, it } from "vitest";
import { createCommunicationAction } from "../src/adapters/boss/communication/communication-action";
import { createCommunicationRunner } from "../src/application/communication-runner";
import { createIntent } from "../src/domain/communication/intent";
import { asJobId } from "../src/domain/support/ids";
import { createNullLogger } from "../src/infrastructure/logging/logger";

// Fixture with a real chat + editor + send button.
const chatHtml = `
<div class="chat-content">
  <div class="chat-header">后端开发工程师 示例科技有限公司</div>
  <div class="message-item me"><div class="text">hi</div></div>
  <div class="chat-editor" contenteditable="true"></div>
  <button class="send-btn">发送</button>
</div>`;

const actionFor = (html: string) => {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = html;
  return createCommunicationAction({
    document: doc,
    clock: { now: () => 1_700_000_000_000 },
    logger: createNullLogger(),
  });
};

describe("probe", () => {
  it("what does the real adapter report when the runner hands it a send-attempted intent?", async () => {
    const action = actionFor(chatHtml);
    // The runner persists SEND_DISPATCHED *before* calling dispatchSend, so the
    // adapter receives phase === "send-attempted".
    const intent = {
      ...createIntent({
        id: "i", jobId: asJobId("j"), sourceUrl: "s",
        messageText: "hello", outgoingBaseline: 0,
        now: 0, ttlMs: 100000,
        expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
      }),
      phase: "send-attempted" as const,
      sendAttemptedAt: 1,
    };
    const r = await action.dispatchSend(intent);
    console.log("DISPATCH RESULT (send-attempted):", JSON.stringify(r));
    expect(r.kind).toBe("refused");
  });
});
