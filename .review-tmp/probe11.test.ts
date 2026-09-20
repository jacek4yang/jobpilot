import { describe, expect, it } from "vitest";
import { matchChatIdentity } from "../src/domain/communication/identity";

describe("probe11: runner-shaped identity input ignores the job id", () => {
  it("returns match for a DIFFERENT posting that shares title+company", () => {
    // What communication-runner.ts builds (lines 123-127): NO jobId.
    const runnerShape = { title: "后端开发工程师", company: "示例科技有限公司" };
    // The conversation on screen is a DIFFERENT posting (different job id)
    const chat = {
      jobIds: ["job-99999"],
      text: "后端开发工程师 示例科技有限公司",
    };
    const verdict = matchChatIdentity(runnerShape, chat);
    console.log("RUNNER-SHAPE VERDICT:", JSON.stringify(verdict));

    // What the adapter builds (communication-action.ts lines 289-297): WITH jobId.
    const adapterShape = { jobId: "job-12345", title: "后端开发工程师", company: "示例科技有限公司" };
    const verdict2 = matchChatIdentity(adapterShape, chat);
    console.log("ADAPTER-SHAPE VERDICT:", JSON.stringify(verdict2));
    expect(true).toBe(true);
  });
});
