/**
 * Small shared domain helpers.
 *
 * Domain code must stay free of DOM / GM_* / platform dependencies so that it
 * can run under plain Node.js in unit tests.
 */

export interface Clock {
  now(): number;
}

export interface Random {
  /** Returns a float in [0, 1). */
  next(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const mathRandom: Random = {
  next: () => Math.random(),
};

/**
 * Deterministic 32-bit FNV-1a hash rendered as 8 lowercase hex chars.
 *
 * Used for fingerprinting jobs when a platform does not expose a stable id.
 * Deterministic on purpose: the same job must always produce the same id so
 * that deduplication survives reloads.
 */
export const fnv1a32 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 with 32-bit overflow semantics
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
