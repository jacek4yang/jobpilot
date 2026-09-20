/**
 * City resolution for BOSS Zhipin.
 *
 * BOSS's search uses a 9-digit city code, not a city name. Resolving a name to
 * a code is therefore a prerequisite for building a search URL, and getting it
 * wrong silently would send the user to the wrong city's results.
 *
 * Policy (deliberately strict):
 *   - an exact match resolves;
 *   - a name with a common administrative suffix stripped resolves;
 *   - anything else FAILS EXPLICITLY. There is no default city.
 *
 * The reference scraper independently arrived at the same policy, documenting
 * that an unrecognised city "exits with an error instead of silently producing
 * zero results".
 */
import { BOSS_CITY_CODES } from "./city-codes";

export const NATIONWIDE_CITY_CODE = "100010000";
export const NATIONWIDE_CITY_NAME = "全国";

/** Administrative suffixes removed when normalising a city name for lookup. */
const CITY_SUFFIXES: readonly string[] = [
  "特别行政区",
  "维吾尔自治区",
  "回族自治区",
  "壮族自治区",
  "自治州",
  "自治县",
  "地区",
  "盟",
  "省",
  "市",
  "县",
  "区",
];

/** Normalises a city name for lookup: trim, drop whitespace, strip one suffix. */
export const normalizeCityName = (input: string): string => {
  const base = input.trim().replace(/\s+/g, "");
  if (base.length === 0) return "";
  for (const suffix of CITY_SUFFIXES) {
    if (base.length > suffix.length && base.endsWith(suffix)) {
      return base.slice(0, base.length - suffix.length);
    }
  }
  return base;
};

export type CityResolution =
  | {
      readonly ok: true;
      readonly code: string;
      /** The canonical name as published in the BOSS table. */
      readonly name: string;
      /** True when resolution required normalising the user's input. */
      readonly normalized: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "empty" | "unknown";
      readonly input: string;
      /** Closest published names, offered as suggestions rather than a guess. */
      readonly suggestions: readonly string[];
    };

/** Finds published city names that contain the input, for error messages only. */
const suggest = (needle: string, limit = 5): readonly string[] => {
  if (needle.length === 0) return [];
  const matches: string[] = [];
  for (const name of Object.keys(BOSS_CITY_CODES)) {
    if (name.includes(needle) || needle.includes(name)) matches.push(name);
    if (matches.length >= limit) break;
  }
  return matches;
};

/**
 * Resolves a user-supplied city name to a BOSS city code.
 *
 * Returns a failure result — never a fallback — when the name is not in the
 * published table. Callers must surface the failure to the user.
 */
export const resolveCityCode = (input: string): CityResolution => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", input, suggestions: [] };
  }

  // A 9-digit all-numeric input is already a code; accept it only if the table
  // contains it, so typos cannot smuggle in an arbitrary code.
  if (/^\d{9}$/.test(trimmed)) {
    for (const [name, code] of Object.entries(BOSS_CITY_CODES)) {
      if (code === trimmed) return { ok: true, code, name, normalized: false };
    }
    return { ok: false, reason: "unknown", input, suggestions: [] };
  }

  const direct = BOSS_CITY_CODES[trimmed];
  if (direct !== undefined) return { ok: true, code: direct, name: trimmed, normalized: false };

  const normalized = normalizeCityName(trimmed);
  const viaNormalized = BOSS_CITY_CODES[normalized];
  if (viaNormalized !== undefined) {
    return { ok: true, code: viaNormalized, name: normalized, normalized: true };
  }

  return {
    ok: false,
    reason: "unknown",
    input,
    suggestions: suggest(normalized.length > 0 ? normalized : trimmed),
  };
};

/** Resolves many cities, partitioning successes from failures. */
export const resolveCityCodes = (
  inputs: readonly string[],
): {
  readonly resolved: readonly {
    readonly input: string;
    readonly code: string;
    readonly name: string;
  }[];
  readonly failed: readonly CityResolution[];
} => {
  const resolved: { input: string; code: string; name: string }[] = [];
  const failed: CityResolution[] = [];
  for (const input of inputs) {
    const result = resolveCityCode(input);
    if (result.ok) {
      resolved.push({ input, code: result.code, name: result.name });
    } else {
      failed.push(result);
    }
  }
  return { resolved, failed };
};

/** All published city names, sorted. Used to populate the settings picker. */
export const listCityNames = (): readonly string[] => Object.keys(BOSS_CITY_CODES);

/** True when the name resolves. Convenience for validation paths. */
export const isKnownCity = (input: string): boolean => resolveCityCode(input).ok;
