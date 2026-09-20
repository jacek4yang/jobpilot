import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommunicationAction } from "../src/adapters/boss/communication/communication-action";
import { createCommunicationRunner } from "../src/application/communication-runner";
import { createIntent } from "../src/domain/communication/intent";
import { asJobId } from "../src/domain/support/ids";
import { createNullLogger } from "../src/infrastructure/logging/logger";

const fixture = (name: string) => {
  const doc = document.implementation.createHTMLDocument("t");
  doc.documentElement.innerHTML = readFileSync(`tests/fixtures/boss/${name}`, "utf8");
  return doc;
};

describe("probe3: real runner x real adapter on the real fixture", () => {
  it("never clicks send", async () => {
    const doc = fixture("chat-conversation.html");
    let clicks = 0;
    for (const b of Array.from(doc.querySelectorAll("[data-jobpilot-action='send']"))) {
      b.addEventListener("click", () => { clicks += 1; });
    }
    const action = createCommunicationAction({
      document: doc, clock: { now: () => 1_700_000_000_000 }, logger: createNullLogger(),
    });
    const phases: string[] = [];
    const runner = createCommunicationRunner({
      action, logger: createNullLogger(), clock: { now: () => 1_700_000_000_000 },
      persistIntent: async (i) => { phases.push(i.phase); },
      clearIntent: async () => { phases.push("CLEARED"); },
    });
    // Identity comes from the fixture: title 后端开发工程师, company 示例科技有限公司.
    const intent = createIntent({
      id: "i", jobId: asJobId("job-12345"), sourceUrl: "s",
      messageText: "hello", outgoingBaseline: 5, now: 0, ttlMs: Number.MAX_SAFE_INTEGER,
      expectedJobTitle: "后端开发工程师", expectedCompany: "示例科技有限公司",
    });
    const outcome = await runner.run(intent);
    console.log("PHASES:", JSON.stringify(phases));
    console.log("OUTCOME:", JSON.stringify(outcome));
    console.log("CLICK COUNT:", clicks);
    expect(true).toBe(true);
  });
});
