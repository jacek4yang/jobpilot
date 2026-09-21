import type { Storage } from "../../ports/storage";

/**
 * Absent hosts simply do not define the global, so every call site checks the
 * function before using it. The hosts themselves are also allowed to be
 * `undefined`, which is what makes this file safe to import under Node.js.
 */
declare global {
  var GM_getValue: ((key: string, defaultValue?: unknown) => unknown) | undefined;
  var GM_setValue: ((key: string, value: unknown) => void) | undefined;
  var GM_deleteValue: ((key: string) => void) | undefined;
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
 * A missing key is normal. A malformed payload is not: treating corruption as
 * an empty install could overwrite the only durable duplicate-send record.
 * Let JSON.parse throw so the health wrapper can enter degraded read-only mode.
 */
const parseStored = (raw: unknown): unknown => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return raw;
  return JSON.parse(raw);
};

export class GMStorage implements Storage {
  async get<T>(key: string): Promise<T | undefined> {
    const reader = gmFunction<ReadValue>("GM_getValue");
    if (reader === undefined) throw new Error("GM_getValue is unavailable");
    const parsed = parseStored(reader(prefixed(key), undefined));
    return parsed as T | undefined;
  }

  set<T>(key: string, value: T): Promise<void> {
    const writer = gmFunction<WriteValue>("GM_setValue");
    if (writer === undefined) return Promise.reject(new Error("GM_setValue is unavailable"));
    try {
      writer(prefixed(key), JSON.stringify(value));
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    const remover = gmFunction<DeleteValue>("GM_deleteValue");
    if (remover === undefined) return Promise.reject(new Error("GM_deleteValue is unavailable"));
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
