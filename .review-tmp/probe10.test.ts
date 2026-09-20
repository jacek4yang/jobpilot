import { describe, expect, it } from "vitest";
import { createController } from "../src/application/controller";
import type { Effect } from "../src/application/events";

const logger = { debug(){},info(){},warn(){},error(){},entries(){return[]},clear(){} };
const clock = { now: () => 1000 };
const watchdog = { watch(){}, reset(){}, start(){}, stop(){}, running: false };

describe("probe10: persist ordering", () => {
  it("are persists serialised in dispatch order?", async () => {
    const events: string[] = [];
    let park!: () => void;
    const gate = new Promise<void>((r) => { park = r; });

    const orchestrator = {
      async runEffect(effect: Effect) {
        events.push(`start:${effect.type}`);
        if (effect.type === "scan-jobs") await gate;   // first persist delayed
        events.push(`end:${effect.type}`);
      },
      dispose() {},
    };
    let persistCount = 0;
    const controller = createController({
      clock, logger, orchestrator: orchestrator as never, history: {} as never,
      watchdog: watchdog as never, maxRetries: 1,
      onChange: () => {},
      onPersist: async () => { persistCount += 1; events.push(`persist#${persistCount}`); },
    });

    controller.dispatch({ type: "START" });      // effects: scan-jobs, persist
    await new Promise((r) => setTimeout(r, 0));
    controller.dispatch({ type: "STOP" });       // effects: stop, persist
    await new Promise((r) => setTimeout(r, 0));
    console.log("EVENTS (before unpark):", JSON.stringify(events));
    park();
    await new Promise((r) => setTimeout(r, 10));
    console.log("EVENTS (final):", JSON.stringify(events));
    expect(true).toBe(true);
  });

  it("is the context passed to runEffect the post-transition one?", async () => {
    const seen: string[] = [];
    const orchestrator = {
      async runEffect(effect: Effect, ctx: { state: string }) { seen.push(`${effect.type}@${ctx.state}`); },
      dispose() {},
    };
    const controller = createController({
      clock, logger, orchestrator: orchestrator as never, history: {} as never,
      watchdog: watchdog as never, maxRetries: 1,
      onChange: () => {}, onPersist: async () => {},
    });
    controller.dispatch({ type: "START" });
    await new Promise((r) => setTimeout(r, 5));
    console.log("SEEN:", JSON.stringify(seen));
    expect(true).toBe(true);
  });
});
