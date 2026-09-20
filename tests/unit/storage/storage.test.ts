import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GMStorage, KEY_PREFIX, MemoryStorage } from "../../../src/adapters/storage";
import type { Storage } from "../../../src/ports/storage";

interface Sample {
  readonly id: string;
  readonly nested: { readonly tags: readonly string[] };
}

const sample = (): Sample => ({ id: "app_1", nested: { tags: ["a", "b"] } });

describe("MemoryStorage", () => {
  it("round-trips a value", async () => {
    const storage = new MemoryStorage();
    await storage.set("config", sample());
    expect(await storage.get<Sample>("config")).toEqual(sample());
  });

  it("returns undefined for an absent key", async () => {
    const storage = new MemoryStorage();
    expect(await storage.get("missing")).toBeUndefined();
  });

  it("returns undefined after a delete", async () => {
    const storage = new MemoryStorage();
    await storage.set("config", sample());
    await storage.delete("config");
    expect(await storage.get("config")).toBeUndefined();
  });

  it("tolerates deleting an absent key", async () => {
    const storage = new MemoryStorage();
    await expect(storage.delete("never-existed")).resolves.toBeUndefined();
  });

  it("returns a clone, so mutating the read value cannot affect the store", async () => {
    const storage = new MemoryStorage();
    await storage.set("config", sample());

    const first = await storage.get<Sample>("config");
    expect(first).toBeDefined();
    // Deliberately mutate through a locally widened view.
    const mutable = first as { id: string; nested: { tags: string[] } };
    mutable.id = "tampered";
    mutable.nested.tags.push("injected");

    const second = await storage.get<Sample>("config");
    expect(second).toEqual(sample());
    expect(second?.nested.tags).toEqual(["a", "b"]);
  });

  it("does not alias the object handed to set", async () => {
    const storage = new MemoryStorage();
    const source = sample();
    await storage.set("config", source);
    (source as { id: string }).id = "mutated-after-set";
    expect(await storage.get<Sample>("config")).toEqual(sample());
  });

  it("seeds from a record", async () => {
    const storage = new MemoryStorage({ config: sample(), count: 3 });
    expect(await storage.get<Sample>("config")).toEqual(sample());
    expect(await storage.get<number>("count")).toBe(3);
  });

  it("clones seeded values too", async () => {
    const storage = new MemoryStorage({ config: sample() });
    const read = await storage.get<Sample>("config");
    (read as { id: string }).id = "tampered";
    expect(await storage.get<Sample>("config")).toEqual(sample());
  });

  it("lists keys, including keys whose value is undefined", async () => {
    const storage = new MemoryStorage();
    await storage.set("a", 1);
    await storage.set("b", 2);
    expect((await storage.keys()).slice().sort()).toEqual(["a", "b"]);
    await storage.delete("a");
    expect(await storage.keys()).toEqual(["b"]);
  });

  it("satisfies the Storage port", () => {
    const storage: Storage = new MemoryStorage();
    expect(typeof storage.get).toBe("function");
  });

  it("stores falsy values without losing them", async () => {
    const storage = new MemoryStorage();
    await storage.set("zero", 0);
    await storage.set("empty", "");
    await storage.set("no", false);
    expect(await storage.get<number>("zero")).toBe(0);
    expect(await storage.get<string>("empty")).toBe("");
    expect(await storage.get<boolean>("no")).toBe(false);
  });
});

describe("GMStorage", () => {
  /** A minimal in-memory stand-in for a userscript manager's storage. */
  const installGmStubs = (options: { readonly listValues?: boolean } = {}) => {
    const backing = new Map<string, unknown>();
    const withList = options.listValues !== false;

    Reflect.set(globalThis, "GM_getValue", (key: string, defaultValue?: unknown): unknown =>
      backing.has(key) ? backing.get(key) : defaultValue,
    );
    Reflect.set(globalThis, "GM_setValue", (key: string, value: unknown): void => {
      backing.set(key, value);
    });
    Reflect.set(globalThis, "GM_deleteValue", (key: string): void => {
      backing.delete(key);
    });
    if (withList) {
      Reflect.set(globalThis, "GM_listValues", (): string[] => [...backing.keys()]);
    }
    return backing;
  };

  const removeGmStubs = () => {
    for (const name of ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"]) {
      Reflect.deleteProperty(globalThis, name);
    }
  };

  let backing: Map<string, unknown>;

  beforeEach(() => {
    backing = installGmStubs();
  });

  afterEach(() => {
    removeGmStubs();
  });

  it("round-trips a value through the stubbed globals", async () => {
    const storage = new GMStorage();
    await storage.set("config", sample());
    expect(await storage.get<Sample>("config")).toEqual(sample());
  });

  it("writes JSON text under a namespaced key", async () => {
    const storage = new GMStorage();
    await storage.set("config", { a: 1 });
    expect(backing.get(`${KEY_PREFIX}config`)).toBe('{"a":1}');
  });

  it("returns undefined for an absent key", async () => {
    const storage = new GMStorage();
    expect(await storage.get("missing")).toBeUndefined();
  });

  it("returns undefined for a non-JSON payload instead of throwing", async () => {
    backing.set(`${KEY_PREFIX}broken`, "{ not json");
    const storage = new GMStorage();
    await expect(storage.get("broken")).resolves.toBeUndefined();
  });

  it("returns undefined for a truncated payload", async () => {
    backing.set(`${KEY_PREFIX}truncated`, '{"a":');
    const storage = new GMStorage();
    expect(await storage.get("truncated")).toBeUndefined();
  });

  it("deletes a key", async () => {
    const storage = new GMStorage();
    await storage.set("config", { a: 1 });
    await storage.delete("config");
    expect(backing.has(`${KEY_PREFIX}config`)).toBe(false);
    expect(await storage.get("config")).toBeUndefined();
  });

  it("lists only namespaced keys, unprefixed", async () => {
    const storage = new GMStorage();
    await storage.set("one", 1);
    await storage.set("two", 2);
    backing.set("someone-elses-key", "x");
    expect((await storage.keys()).slice().sort()).toEqual(["one", "two"]);
  });

  it("falls back to an empty key list when GM_listValues is unavailable", async () => {
    removeGmStubs();
    backing = installGmStubs({ listValues: false });
    const storage = new GMStorage();
    await storage.set("config", { a: 1 });
    expect(await storage.keys()).toEqual([]);
    // Reads still work through the remaining globals.
    expect(await storage.get<{ a: number }>("config")).toEqual({ a: 1 });
  });

  it("degrades to no-ops when the GM globals are missing entirely", async () => {
    removeGmStubs();
    const storage = new GMStorage();
    await expect(storage.set("config", { a: 1 })).resolves.toBeUndefined();
    await expect(storage.get("config")).resolves.toBeUndefined();
    await expect(storage.delete("config")).resolves.toBeUndefined();
    expect(await storage.keys()).toEqual([]);
  });

  it("does not throw when the stored value is not JSON serialisable", async () => {
    const storage = new GMStorage();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await expect(storage.set("cyclic", cyclic)).resolves.toBeUndefined();
  });

  it("satisfies the Storage port", () => {
    const storage: Storage = new GMStorage();
    expect(typeof storage.keys).toBe("function");
  });
});
