/**
 * Search page form model (pure logic).
 *
 * The Search page UI is a Vue SFC, but everything it does — resolving which
 * profile is being edited, mapping a stored profile to editable form values
 * and building the persisted profile back from those values — is plain data
 * transformation. It lives here, fully unit-tested, so the SFC stays thin
 * template + setup glue.
 *
 * Persistence model (unchanged from the hand-rolled page): every control
 * change writes the full profile through to `onSaveSearchProfile`, and a
 * module-scope draft per profile id wins over the persisted profile on
 * re-render, so a keystroke can never be wiped by a re-render that lands
 * before the storage round-trip completes.
 */

import type { JobPilotConfig, StoredSearchProfile } from "../../../config/schema";

/**
 * Editable form state for one search profile. Text fields hold the raw input
 * values (comma/space separated); chip groups and the activity select hold
 * structured values; salaries are parsed numbers or undefined when empty.
 */
export interface SearchFormModel {
  keywords: string;
  cities: string;
  salaryMinK: number | undefined;
  salaryMaxK: number | undefined;
  experience: readonly string[];
  degree: readonly string[];
  companyScales: readonly string[];
  recruiterActivity: string | undefined;
  includeKeywords: string;
  excludeKeywords: string;
}

/** Quick-pick city chips, mirroring the hand-rolled page. */
export const COMMON_CITIES: readonly string[] = [
  "北京",
  "上海",
  "深圳",
  "杭州",
  "广州",
  "成都",
  "武汉",
  "西安",
];

/** Splits a comma/space-separated input into clean tokens. */
export const splitTokens = (value: string): readonly string[] =>
  value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses a salary input; empty or non-numeric yields undefined. */
export const salaryValue = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * The newest edited profile per profile id. Survives re-renders within the
 * page lifetime; a full page reload resets it, and storage holds the truth.
 */
export const drafts = new Map<string, StoredSearchProfile>();

/** The persisted profile this page edits: the first enabled one, if any. */
const enabledProfile = (config: JobPilotConfig | undefined): StoredSearchProfile | undefined =>
  config?.profiles?.find((p) => p.enabled);

/** Stable profile id for the current config: the enabled profile, else a fallback. */
export const resolveProfileId = (config: JobPilotConfig | undefined): string =>
  enabledProfile(config)?.id ?? "default-profile";

/** Shape used when no enabled profile is persisted (verbatim from the old page). */
const fallbackProfile = (config: JobPilotConfig | undefined, id: string): StoredSearchProfile => ({
  id,
  name: "默认意向",
  keywords: config?.filters?.includeKeywords ?? [],
  cities: config?.filters?.cities ?? [],
  includeKeywords: [],
  excludeKeywords: config?.filters?.excludeKeywords ?? [],
  enabled: true,
});

/**
 * Draft-aware profile resolution. The draft (if any) is newer than anything
 * persisted — it wins — so re-renders driven by stale config cannot wipe
 * typed values.
 */
export const resolveProfile = (
  id: string,
  config: JobPilotConfig | undefined,
): StoredSearchProfile => drafts.get(id) ?? enabledProfile(config) ?? fallbackProfile(config, id);

/** Maps a stored profile (or the config-derived fallback) to editable form values. */
export const modelFromProfile = (
  profile: StoredSearchProfile | undefined,
  config: JobPilotConfig | undefined,
): SearchFormModel => {
  const resolved = profile ?? fallbackProfile(config, resolveProfileId(config));
  return {
    keywords: resolved.keywords.join(", "),
    cities: resolved.cities.join(", "),
    salaryMinK: resolved.salaryMinK,
    salaryMaxK: resolved.salaryMaxK,
    experience: [...(resolved.experience ?? [])],
    degree: [...(resolved.degree ?? [])],
    companyScales: [...(resolved.companyScales ?? [])],
    recruiterActivity: resolved.recruiterActivity,
    includeKeywords: resolved.includeKeywords.join(", "),
    excludeKeywords: resolved.excludeKeywords.join(", "),
  };
};

/** Salaries that already reached the model are still sanitised defensively. */
const sanitizeSalary = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Builds the persisted profile from form values. Empty fields are omitted
 * (omit-empty): an untouched salary range or chip group must not reappear as
 * explicit zero/empty values in storage.
 */
export const profileFromModel = (
  id: string,
  name: string,
  model: SearchFormModel,
): StoredSearchProfile => {
  const minK = sanitizeSalary(model.salaryMinK);
  const maxK = sanitizeSalary(model.salaryMaxK);
  return {
    id,
    name,
    enabled: true,
    keywords: [...splitTokens(model.keywords)],
    cities: [...splitTokens(model.cities)],
    includeKeywords: [...splitTokens(model.includeKeywords)],
    excludeKeywords: [...splitTokens(model.excludeKeywords)],
    ...(minK === undefined ? {} : { salaryMinK: minK }),
    ...(maxK === undefined ? {} : { salaryMaxK: maxK }),
    ...(model.experience.length === 0 ? {} : { experience: [...model.experience] }),
    ...(model.degree.length === 0 ? {} : { degree: [...model.degree] }),
    ...(model.companyScales.length === 0 ? {} : { companyScales: [...model.companyScales] }),
    ...(model.recruiterActivity === undefined || model.recruiterActivity.length === 0
      ? {}
      : { recruiterActivity: model.recruiterActivity }),
  };
};
