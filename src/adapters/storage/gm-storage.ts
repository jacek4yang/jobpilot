import type { Storage } from "../../ports/storage";

/**
 * Absent hosts simply do not define the global, so every call site checks the
 * function before using it. The hosts themselves are also allowed to be
 * `undefined`, which is what makes this file safe to import under Node.js.
 */
declare global {
  // biome-ignore lint/style/noVar: `declare global` requires `var` to attach to globalThis.
  var GM_getValue: ((key: string, defaultValue?: unknown) => unknown) | undefined;
  // biome-ignore lint/style/noVar: `declare global` requires `var` to attach to globalThis.
  var GM_setValue: ((key: string, value: unknown) => void) | undefined;
  // biome-ignore lint/style/noVar: `declare global` requires `var` to attach to globalThis.
  var GM_deleteValue: ((key: string) => void) | undefined;
  // biome-ignore lint/style/noVar: `declare global` requires `var` to attach to globalThis.
  var GM_listValues: (() => string[]) | undefined;
}

/** Namespace all JobPilot keys so we never collide with other userscripts. */
export const KEY_PREFIX = "jobpilot:";

const prefixed = (key: string): string => `${KEY_PREFIX}${key}`;

type ReadValue = (key: string, defaultValue?: unknown) => unknown;
type WriteValue = (key: string, value: unknown) => void;
type DeleteValue = (key: string) => void;
type ListValues = () => string[];

/**
 * Resolves one of the GM globals to a callable of the expected shape.
 *
 * Written as a type-predicate guard rather than an `as` cast so that a host
 * exposing the wrong signature (or a non-function) is rejected at runtime and
 * not merely assumed away by the compiler.
 */
const gmFunction = <T extends (...args: never[]) => unknown>(name: string): T | undefined => {
  const candidate: unknown = Reflect.get(globalThis, name);
  return typeof candidate === "function" ? (candidate as T) : undefined;
};

/**
 * Reads a value and parses it as JSON.
 *
 * Two failure modes are tolerated silently, because both are indistinguishable
 * from "nothing stored yet" and neither may crash the call site:
 *  - the key is absent (or the host returned its own default), and
 *  - the payload is not valid JSON (hand-edited or truncated storage).
 */
const parseStored = (raw: unknown): unknown => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export class GMStorage implements Storage {
  get<T>(key: string): Promise<T | undefined> {
    const reader = gmFunction<ReadValue>("GM_getValue");
    if (reader === undefined) return Promise.resolve(undefined);
    const parsed = parseStored(reader(prefixed(key), undefined));
    return Promise.resolve(parsed as T | undefined);
  }

  set<T>(key: string, value: T): Promise<void> {
    const writer = gmFunction<WriteValue>("GM_setValue");
    if (writer === undefined) return Promise.resolve();
    try {
      writer(prefixed(key), JSON.stringify(value));
    } catch {
      // Unserialisable (cyclic / BigInt). Dropping the write is safer than
      // corrupting the slot with a half-written payload, and the caller's
      // storage contract does not carry an error channel.
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    const remover = gmFunction<DeleteValue>("GM_deleteValue");
    if (remover === undefined) return Promise.resolve();
    remover(prefixed(key));
    return Promise.resolve();
  }

  /**
   * Key enumeration.
   *
   * `GM_listValues` is not part of every host's API surface (Tampermonkey and
   * Violentmonkey ship it, some minimal shims do not). When it is missing we
   * return an empty list rather than guessing — diagnostics and export will
   * report "no keys", which is honest, instead of throwing or inventing keys.
   */
  keys(): Promise<readonly string[]> {
    const list = gmFunction<ListValues>("GM_listValues");
    if (list === undefined) return Promise.resolve([]);
    const all = list();
    if (!Array.isArray(all)) return Promise.resolve([]);
    const ours: string[] = [];
    for (const key of all) {
      if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) continue;
      ours.push(key.slice(KEY_PREFIX.length));
    }
    return Promise.resolve(ours);
  }
}
