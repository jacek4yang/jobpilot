import { describe, expect, it } from "vitest";
import { createNavigatorLock } from "../src/adapters/userscript/navigator-lock";

// Models the REAL navigator.locks semantics closely:
//  - request() returns a promise that settles only when the callback's promise resolves.
//  - the callback is invoked ASYNCHRONOUSLY (a macrotask), as the spec requires.
const makeRealisticLocks = () => {
  let held = false;
  const log: string[] = [];
  return {
    log, isHeld: () => held,
    request(name: string, _options: { ifAvailable: boolean }, cb: (l: unknown) => Promise<void>) {
      log.push(`request(held=${held})`);
      return new Promise<void>((settle) => {
        setTimeout(() => {                       // <-- async grant, per spec
          if (held) { log.push("cb(null)"); void cb(null).then(settle); return; }
          held = true;
          log.push("cb(granted)");
          void Promise.resolve(cb({ name })).then(() => { held = false; settle(); });
        }, 0);
      });
    },
  };
};

describe("probe7: realistic async lock grant", () => {
  it("does acquire report success?", async () => {
    const locks = makeRealisticLocks();
    const nav = { locks } as unknown as Navigator;
    const lock = createNavigatorLock({ clock: { now: () => 1000 }, navigator: nav });

    const a = await lock.acquire({ ownerId: "tab-A", ttlMs: 1000 });
    console.log("ACQUIRE RESULT:", JSON.stringify(a));
    console.log("BROWSER LOCK ACTUALLY HELD:", locks.isHeld());
    await new Promise((r) => setTimeout(r, 10));
    console.log("AFTER GRANT TASK RAN, browserHeld:", locks.isHeld());
    console.log("app currentHolder:", await lock.currentHolder());
    // Meanwhile the browser lock is now held until this page dies. Another tab:
    const b = await lock.acquire({ ownerId: "tab-B", ttlMs: 1000 });
    console.log("TAB B ACQUIRE:", JSON.stringify(b));
    expect(true).toBe(true);
  });
});
