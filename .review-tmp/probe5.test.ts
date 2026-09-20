import { describe, expect, it } from "vitest";
import { createNavigatorLock } from "../src/adapters/userscript/navigator-lock";

// Minimal navigator.locks that models ifAvailable: when held, callback gets null.
const makeLocks = () => {
  let held = false;
  const waiters: (() => void)[] = [];
  return {
    released: () => waiters.length,
    request(_name: string, options: { ifAvailable: boolean }, cb: (l: unknown) => Promise<void>) {
      if (held) { void cb(null); return Promise.resolve(); }
      held = true;
      let release!: () => void;
      const p = new Promise<void>((r) => { release = () => { held = false; r(); }; });
      waiters.push(release);
      void cb({ name: _name });
      return p;
    },
  };
};

describe("probe5: navigator lock", () => {
  it("acquire twice with different ownerId", async () => {
    const locks = makeLocks();
    const nav = { locks } as unknown as Navigator;
    const lock = createNavigatorLock({ clock: { now: () => 1000 }, navigator: nav });

    const a = await lock.acquire({ ownerId: "tab-A", ttlMs: 1000 });
    console.log("A:", JSON.stringify(a));
    const b = await lock.acquire({ ownerId: "tab-B", ttlMs: 1000 });
    console.log("B:", JSON.stringify(b));
    // Now check: is the browser lock actually still held / can it be released?
    await lock.release("tab-A");
    console.log("after release(A) currentHolder:", await lock.currentHolder());
    // A third tab tries to take over:
    const c = await lock.acquire({ ownerId: "tab-C", ttlMs: 1000 });
    console.log("C:", JSON.stringify(c));
    expect(true).toBe(true);
  });
});
