import { describe, expect, it } from "vitest";
import { createController } from "../src/application/controller";
import { initialContext } from "../src/application/state";
import type { Effect } from "../src/application/events";

const logger = { debug(){},info(){},warn(){},error(){},entries(){return[]},clear(){} };
const clock = { now: () => 1000 };
const watchdog = { watch(){}, reset(){}, start(){}, stop(){}, running: false };

describe("probe9: controller pending queue / dispose", () => {
  it("does an effect run after dispose()?", async () => {
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const orchestrator = {
      async runEffect(effect: Effect) {
        ran.push(effect.type);
        if (effect.type === "scan-jobs") await gate;  // suspend mid-effect
      },
      dispose() { ran.push("orchestrator.dispose"); },
    };

    const controller = createController({
      clock, logger, orchestrator: orchestrator as never, history: {} as never,
      watchdog: watchdog as never, maxRetries: 1,
      onChange: () => {}, onPersist: async () => {},
    });

    controller.dispatch({ type: "START" });   // spawns async IIFE running scan-jobs (gated)
    await new Promise((r) => setTimeout(r, 0));
    console.log("ran before dispose:", JSON.stringify(ran));

    controller.dispose();
    console.log("ran after dispose:", JSON.stringify(ran));

    release();
    await new Promise((r) => setTimeout(r, 5));
    console.log("ran after gate released (post-dispose):", JSON.stringify(ran));
    expect(true).toBe(true);
  });

  it("can pending grow unbounded while an effect is parked?", async () => {
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orchestrator = {
      async runEffect(effect: Effect) {
        ran.push(effect.type);
        if (effect.type === "scan-jobs") await gate;
      },
      dispose() {},
    };
    const controller = createController({
      clock, logger, orchestrator: orchestrator as never, history: {} as never,
      watchdog: watchdog as never, maxRetries: 1,
      onChange: () => {}, onPersist: async () => {},
    });
    controller.dispatch({ type: "START" });
    await new Promise((r) => setTimeout(r, 0));
    // While scan-jobs is parked, fire many events.
    for (let i = 0; i < 5; i++) controller.dispatch({ type: "SCAN_STARTED" });
    release();
    await new Promise((r) => setTimeout(r, 10));
    console.log("ran total:", JSON.stringify(ran));
    expect(true).toBe(true);
  });
});
