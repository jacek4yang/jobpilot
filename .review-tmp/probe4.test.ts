import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createCommunicationAction } from "../src/adapters/boss/communication/communication-action";
import { createCommunicationRunner } from "../src/application/communication-runner";
import { createIntent } from "../src/domain/communication/intent";
import { asJobId } from "../src/domain/support/ids";

const load = (name: string): ParentNode => {
  const html = readFileSync(`tests/fixtures/boss/${name}`, "utf8");
  const w = new Window({ url: "https://www.zhipin.com/web/geek/chat" });
  w.document.write(`<!doctype html>\n${html}`);
  return w.document as unknown as ParentNode;
};
const logger = { debug(){},info(){},warn(){},error(){},entries(){return[]},clear(){} };

describe("probe4", () => {
  it("real runner x real adapter, real Window", async () => {
    const root = load("chat-conversation.html");
    const doc = root as unknown as Document;
    let clicks = 0;
    for (const b of Array.from(doc.querySelectorAll("[data-jobpilot-action='send']"))) {
      b.addEventListener("click", () => { clicks += 1; });
    }
    const action = createCommunicationAction({ document: root, clock: { now: () => 1_704_067_200_000 }, logger });
    const phases: string[] = [];
    const runner = createCommunicationRunner({
      action, logger, clock: { now: () => 1_704_067_200_000 },
      persistIntent: async (i) => { phases.push(i.phase); },
      clearIntent: async () => { phases.push("CLEARED"); },
    });
    const intent = createIntent({
      id: "intent-1", jobId: asJobId("job-12345"),
      sourceUrl: "https://www.zhipin.com/job_detail/job-12345.html",
      messageText: "您好，我对这个职位很感兴趣，方便聊聊吗？",
      outgoingBaseline: 0, now: 0, ttlMs: Number.MAX_SAFE_INTEGER,
      expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
    });
    const outcome = await runner.run(intent, { observeTimeoutMs: 50, observeIntervalMs: 5 });
    console.log("PHASES:", JSON.stringify(phases));
    console.log("OUTCOME:", JSON.stringify(outcome));
    console.log("CLICK COUNT:", clicks);
    expect(true).toBe(true);
  });
});
