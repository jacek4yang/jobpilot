import { describe, expect, it } from "vitest";
import { createNavigatorLock } from "../src/adapters/userscript/navigator-lock";

const makeLocks = () => {
  let held = false;
  return {
    isHeld: () => held,
    request(_n: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => Promise<void>) {
      return new Promise<void>((settle) => {
        setTimeout(() => {
          if (held) { void cb(null).then(settle); return; }
          held = true;
          void Promise.resolve(cb({ name: _n })).then(() => { held = false; settle(); });
        }, 0);
      });
    },
  };
};

describe("probe8: repeated acquire in the SAME tab (double mount)", () => {
  it("second acquire overwrites holdOpen", async () => {
    const locks = makeLocks();
    const nav = { locks } as unknown as Navigator;
    const lock = createNavigatorLock({ clock: { now: () => 1000 }, navigator: nav });

    void await lock.acquire({ ownerId: "tab-A", ttlMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    console.log("after first grant, browserHeld:", locks.isHeld(), "holder:", await lock.currentHolder());

    // A second mount / re-acquire in the same tab with the SAME ownerId:
    const second = await lock.acquire({ ownerId: "tab-A", ttlMs: 1000 });
    console.log("second acquire:", JSON.stringify(second));

    // Now release and see if the browser lock actually frees.
    await lock.release("tab-A");
    await new Promise((r) => setTimeout(r, 5));
    console.log("after release, browserHeld (should be false):", locks.isHeld());
    console.log("app holder:", await lock.currentHolder());
    expect(true).toBe(true);
  });
});
