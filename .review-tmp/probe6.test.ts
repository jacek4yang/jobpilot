import { describe, expect, it } from "vitest";
import { createNavigatorLock } from "../src/adapters/userscript/navigator-lock";

const makeLocks = () => {
  let held = false;
  const log: string[] = [];
  return {
    log,
    isHeld: () => held,
    request(name: string, options: { ifAvailable: boolean }, cb: (l: unknown) => Promise<void>) {
      log.push(`request(held=${held})`);
      if (held) { log.push("callback(null)"); void cb(null); return Promise.resolve(); }
      held = true;
      const p = new Promise<void>((resolve) => {
        setTimeout(() => { held = false; log.push("inner-released"); resolve(); }, 0);
      });
      log.push(`callback(granted)`);
      void cb({ name });
      return p;
    },
  };
};

describe("probe6", () => {
  it("inspect sequence", async () => {
    const locks = makeLocks();
    const nav = { locks } as unknown as Navigator;
    const lock = createNavigatorLock({ clock: { now: () => 1000 }, navigator: nav });
    const a = await lock.acquire({ ownerId: "tab-A", ttlMs: 1000 });
    console.log("A:", JSON.stringify(a), "browserHeld:", locks.isHeld());
    await lock.release("tab-A");
    console.log("after release, browserHeld:", locks.isHeld(), "appHolder:", await lock.currentHolder());
    await new Promise((r) => setTimeout(r, 5));
    console.log("after tick, browserHeld:", locks.isHeld());
    const c = await lock.acquire({ ownerId: "tab-C", ttlMs: 1000 });
    console.log("C:", JSON.stringify(c));
    console.log("LOG:", JSON.stringify(locks.log));
    expect(true).toBe(true);
  });
});
