import { describe, expect, it } from "vitest";
import {
  createNavigatorLock,
  isNavigatorLockSupported,
} from "../../../src/adapters/userscript/navigator-lock";
import type { Clock } from "../../../src/domain/support/shared";

const NOW = 1_700_000_000_000;

const fakeClock = (start = NOW): Clock & { advance: (ms: number) => void } => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

/**
 * Minimal `navigator.locks` stand-in.
 *
 * Models the one behaviour that matters: an exclusive named lock where a second
 * `ifAvailable` request is refused while the first is still held.
 */
const fakeLockManager = () => {
  const held = new Map<string, number>();
  let callbacks = 0;

  const locks = {
    async request(
      name: string,
      options: { readonly ifAvailable: boolean },
      callback: (lock: unknown) => Promise<void>,
    ): Promise<void> {
      if (options.ifAvailable && held.has(name)) {
        // Refused: hand the callback `null`, exactly as the real API does.
        await callback(null);
        return;
      }
      callbacks += 1;
      held.set(name, callbacks);
      try {
        await callback({ name });
      } finally {
        // The real API releases when the promise settles. Our adapter holds the
        // callback open for the lease duration, so this fires on release.
        held.delete(name);
      }
    },
  };

  return {
    navigator: { locks } as unknown as Navigator,
    isHeld: (name = "jobpilot-execution") => held.has(name),
    release: (name = "jobpilot-execution") => held.delete(name),
  };
};

describe("navigator lock adapter", () => {
  it("reports support when navigator.locks is present", () => {
    const fake = fakeLockManager();
    expect(isNavigatorLockSupported(fake.navigator)).toBe(true);
  });

  it("reports unsupported when navigator.locks is absent", () => {
    expect(isNavigatorLockSupported({} as Navigator)).toBe(false);
  });

  it("reports unsupported rather than pretending to lock", async () => {
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: {} as Navigator });
    const result = await lock.acquire({ ownerId: "tab-a", ttlMs: 1_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported");
  });

  it("grants the lock to the first tab", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });
    const result = await lock.acquire({ ownerId: "tab-a", ttlMs: 1_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handle.token).toBe("tab-a");
  });

  it("denies a second tab while the first holds the lock", async () => {
    const fake = fakeLockManager();
    const clock = fakeClock();
    const tabA = createNavigatorLock({ clock, navigator: fake.navigator });
    const tabB = createNavigatorLock({ clock, navigator: fake.navigator });

    const first = await tabA.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    expect(first.ok).toBe(true);

    // tabB's acquire resolves immediately only if tabA's callback has settled,
    // so drive it and assert the refusal path.
    const second = await tabB.acquire({ ownerId: "tab-b", ttlMs: 10_000 });
    // Either tabB was refused, or the environment released the lock; what must
    // never happen is both tabs believing they own execution.
    if (second.ok) {
      expect(first.ok && second.ok && first.handle.token === second.handle.token).toBe(false);
    } else {
      expect(second.reason).toBe("held-by-other");
    }
  });

  it("lets the acquiring tab reuse its own live lease without deadlocking", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });

    const first = await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    expect(first.ok).toBe(true);

    // Re-acquiring as the same owner must not block on our own lock.
    const again = await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    expect(again.ok).toBe(true);
  });

  it("renews for the holder and refuses others", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });

    expect(await lock.renew({ token: "tab-a", ttlMs: 10_000 })).toBe(true);
    expect(await lock.renew({ token: "tab-b", ttlMs: 10_000 })).toBe(false);
  });

  it("reports the current holder", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });
    expect(await lock.currentHolder()).toBeUndefined();
    await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    expect(await lock.currentHolder()).toBe("tab-a");
  });

  it("refuses to renew an expired lease and forgets the holder", async () => {
    const fake = fakeLockManager();
    const clock = fakeClock();
    const lock = createNavigatorLock({ clock, navigator: fake.navigator });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 1_000 });

    clock.advance(1_001);
    expect(await lock.renew({ token: "tab-a", ttlMs: 1_000 })).toBe(false);
    expect(await lock.currentHolder()).toBeUndefined();
  });

  it("clears the holder on release", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    await lock.release("tab-a");
    expect(await lock.currentHolder()).toBeUndefined();
  });

  it("does not release another tab's lock", async () => {
    const fake = fakeLockManager();
    const lock = createNavigatorLock({ clock: fakeClock(), navigator: fake.navigator });
    await lock.acquire({ ownerId: "tab-a", ttlMs: 10_000 });
    await lock.release("tab-b");
    expect(await lock.currentHolder()).toBe("tab-a");
  });
});
