/**
 * Search Profile and preferences editor.
 *
 * Provides organized grouped controls:
 * - 关键词 (Keywords)
 * - 城市 (Cities)
 * - 薪资 (Salary)
 * - 经验 (Experience)
 * - 学历 (Education)
 * - 公司规模 (Company scale)
 * - BOSS 活跃度 (Recruiter activity)
 * - 包含关键词 (Include keywords)
 * - 排除关键词 (Exclude keywords)
 *
 * Persistence model: every control change immediately calls
 * `callbacks.onSaveSearchProfile` with the full profile read back from the
 * inputs, so typed values are written through to storage. Because the panel
 * re-renders (and therefore rebuilds this page) on every async state update,
 * a module-scope draft is kept as well: the newest draft wins over the
 * persisted profile on re-render, so a keystroke can never be wiped by a
 * re-render that lands before the storage round-trip completes.
 */

import type { JobPilotConfig, StoredSearchProfile } from "../../config/schema";
import {
  ACTIVITY_LABELS,
  ACTIVITY_PREFERENCES,
  COMPANY_SCALES,
  DEGREE_LEVELS,
  EXPERIENCE_BANDS,
} from "../../domain/search-profile/profile";
import { el } from "../components/chips";
import { t } from "../i18n";
import type { UiCallbacks } from "../view-model";

export interface SearchPageInput {
  readonly config?: JobPilotConfig | undefined;
  readonly callbacks: UiCallbacks;
}

/**
 * The newest edited profile per profile id. Survives re-renders within the
 * page lifetime; a full page reload resets it, and storage holds the truth.
 */
const profileDrafts = new Map<string, StoredSearchProfile>();

/** Splits a comma/space-separated input into clean tokens. */
const splitTokens = (value: string): readonly string[] =>
  value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses a salary input; empty or non-numeric yields undefined. */
const salaryValue = (input: HTMLInputElement): number | undefined => {
  const raw = input.value.trim();
  if (raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const renderSearchPage = (doc: Document, input: SearchPageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-search");

  const headerCard = el(doc, "div", "jobpilot-card");
  const title = el(doc, "h3", undefined, t("search.title"));
  title.style.margin = "0 0 4px";
  title.style.fontSize = "14px";
  title.style.fontWeight = "600";
  const sub = el(doc, "p", "jobpilot-field-hint", t("search.subtitle"));
  sub.style.margin = "0 0 10px";

  const runBtn = el(doc, "button", "jobpilot-btn", t("search.runSearch"));
  runBtn.type = "button";
  runBtn.setAttribute("data-variant", "primary");
  runBtn.addEventListener("click", () => input.callbacks.discover());

  headerCard.append(title, sub, runBtn);
  container.append(headerCard);

  const persisted = input.config?.profiles?.find((p) => p.enabled);
  const fallbackId = persisted?.id ?? "default-profile";
  const fromConfig: StoredSearchProfile = persisted ?? {
    id: fallbackId,
    name: "默认意向",
    keywords: input.config?.filters?.includeKeywords ?? [],
    cities: input.config?.filters?.cities ?? [],
    includeKeywords: [],
    excludeKeywords: input.config?.filters?.excludeKeywords ?? [],
    enabled: true,
  };
  // The draft (if any) is newer than anything persisted — it wins.
  const profile: StoredSearchProfile = profileDrafts.get(fallbackId) ?? fromConfig;

  /**
   * Writes the current inputs through to the app and stashes the draft, so
   * both re-renders and reloads see the typed values.
   */
  const persistFromInputs = (): void => {
    const minK = salaryValue(minSalary);
    const maxK = salaryValue(maxSalary);
    const next: StoredSearchProfile = {
      id: profile.id,
      name: profile.name,
      enabled: true,
      keywords: splitTokens(kwInput.value),
      cities: splitTokens(cityInput.value),
      includeKeywords: splitTokens(inInput.value),
      excludeKeywords: splitTokens(exInput.value),
      ...(minK === undefined ? {} : { salaryMinK: minK }),
      ...(maxK === undefined ? {} : { salaryMaxK: maxK }),
      ...(selectedExp.size === 0 ? {} : { experience: [...selectedExp] }),
      ...(selectedEdu.size === 0 ? {} : { degree: [...selectedEdu] }),
      ...(selectedScales.size === 0 ? {} : { companyScales: [...selectedScales] }),
      ...(actSelect.value.length === 0 ? {} : { recruiterActivity: actSelect.value }),
    };
    profileDrafts.set(profile.id, next);
    input.callbacks.onSaveSearchProfile?.(next);
  };

  // --- 1. Keywords Group ---
  const kwGroup = el(doc, "div", "jobpilot-card");
  kwGroup.append(el(doc, "label", "jobpilot-field-label", t("search.keywordsGroup")));
  const kwInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  kwInput.placeholder = t("search.keywordsPlaceholder");
  kwInput.value = profile.keywords.join(", ");
  kwInput.addEventListener("input", persistFromInputs);
  kwGroup.append(kwInput);
  container.append(kwGroup);

  // --- 2. Cities Group ---
  const cityGroup = el(doc, "div", "jobpilot-card");
  cityGroup.append(el(doc, "label", "jobpilot-field-label", t("search.citiesGroup")));
  const cityInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  cityInput.placeholder = t("search.citiesPlaceholder");
  cityInput.value = profile.cities.join(", ");
  cityInput.addEventListener("input", persistFromInputs);
  cityGroup.append(cityInput);

  // Common city quick chips
  const commonCities = ["北京", "上海", "深圳", "杭州", "广州", "成都", "武汉", "西安"];
  const cityChips = el(doc, "div", "jobpilot-chips-container");
  for (const city of commonCities) {
    const chip = el(doc, "button", "jobpilot-filter-chip", city);
    chip.type = "button";
    const selected = profile.cities.includes(city);
    chip.setAttribute("data-selected", String(selected));
    chip.addEventListener("click", () => {
      const currentList = [...splitTokens(cityInput.value)];
      const idx = currentList.indexOf(city);
      if (idx >= 0) {
        currentList.splice(idx, 1);
        chip.setAttribute("data-selected", "false");
      } else {
        currentList.push(city);
        chip.setAttribute("data-selected", "true");
      }
      cityInput.value = currentList.join(", ");
      persistFromInputs();
    });
    cityChips.append(chip);
  }
  cityGroup.append(cityChips);
  container.append(cityGroup);

  // --- 3. Salary Range ---
  const salaryGroup = el(doc, "div", "jobpilot-card");
  salaryGroup.append(el(doc, "label", "jobpilot-field-label", t("search.salaryGroup")));
  const salaryRow = el(doc, "div");
  salaryRow.style.display = "flex";
  salaryRow.style.gap = "8px";
  salaryRow.style.alignItems = "center";

  const minSalary = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  minSalary.type = "number";
  minSalary.placeholder = t("search.salaryMin");
  minSalary.value = profile.salaryMinK !== undefined ? String(profile.salaryMinK) : "";
  minSalary.addEventListener("input", persistFromInputs);

  const dash = el(doc, "span", undefined, "—");
  dash.style.color = "var(--jp-text-muted)";

  const maxSalary = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  maxSalary.type = "number";
  maxSalary.placeholder = t("search.salaryMax");
  maxSalary.value = profile.salaryMaxK !== undefined ? String(profile.salaryMaxK) : "";
  maxSalary.addEventListener("input", persistFromInputs);

  salaryRow.append(minSalary, dash, maxSalary);
  salaryGroup.append(salaryRow);
  container.append(salaryGroup);

  // --- 4. Experience Filter ---
  const expGroup = el(doc, "div", "jobpilot-card");
  expGroup.append(el(doc, "label", "jobpilot-field-label", t("search.experienceGroup")));
  const expChips = el(doc, "div", "jobpilot-chips-container");
  const selectedExp = new Set(profile.experience ?? []);
  for (const band of EXPERIENCE_BANDS) {
    const chip = el(doc, "button", "jobpilot-filter-chip", band);
    chip.type = "button";
    chip.setAttribute("data-selected", String(selectedExp.has(band)));
    chip.addEventListener("click", () => {
      if (selectedExp.has(band)) {
        selectedExp.delete(band);
        chip.setAttribute("data-selected", "false");
      } else {
        selectedExp.add(band);
        chip.setAttribute("data-selected", "true");
      }
      persistFromInputs();
    });
    expChips.append(chip);
  }
  expGroup.append(expChips);
  container.append(expGroup);

  // --- 5. Education Filter ---
  const eduGroup = el(doc, "div", "jobpilot-card");
  eduGroup.append(el(doc, "label", "jobpilot-field-label", t("search.educationGroup")));
  const eduChips = el(doc, "div", "jobpilot-chips-container");
  const selectedEdu = new Set(profile.degree ?? []);
  for (const deg of DEGREE_LEVELS) {
    const chip = el(doc, "button", "jobpilot-filter-chip", deg);
    chip.type = "button";
    chip.setAttribute("data-selected", String(selectedEdu.has(deg)));
    chip.addEventListener("click", () => {
      if (selectedEdu.has(deg)) {
        selectedEdu.delete(deg);
        chip.setAttribute("data-selected", "false");
      } else {
        selectedEdu.add(deg);
        chip.setAttribute("data-selected", "true");
      }
      persistFromInputs();
    });
    eduChips.append(chip);
  }
  eduGroup.append(eduChips);
  container.append(eduGroup);

  // --- 6. Company Scale Filter ---
  const scaleGroup = el(doc, "div", "jobpilot-card");
  scaleGroup.append(el(doc, "label", "jobpilot-field-label", t("search.companyScaleGroup")));
  const scaleChips = el(doc, "div", "jobpilot-chips-container");
  const selectedScales = new Set(profile.companyScales ?? []);
  for (const scale of COMPANY_SCALES) {
    const chip = el(doc, "button", "jobpilot-filter-chip", scale);
    chip.type = "button";
    chip.setAttribute("data-selected", String(selectedScales.has(scale)));
    chip.addEventListener("click", () => {
      if (selectedScales.has(scale)) {
        selectedScales.delete(scale);
        chip.setAttribute("data-selected", "false");
      } else {
        selectedScales.add(scale);
        chip.setAttribute("data-selected", "true");
      }
      persistFromInputs();
    });
    scaleChips.append(chip);
  }
  scaleGroup.append(scaleChips);
  container.append(scaleGroup);

  // --- 7. Recruiter Activity ---
  const actGroup = el(doc, "div", "jobpilot-card");
  actGroup.append(el(doc, "label", "jobpilot-field-label", t("search.activityGroup")));
  const actSelect = el(doc, "select", "jobpilot-select") as HTMLSelectElement;
  for (const act of ACTIVITY_PREFERENCES) {
    const opt = el(doc, "option", undefined, ACTIVITY_LABELS[act]);
    opt.value = act;
    if (profile.recruiterActivity === act) opt.selected = true;
    actSelect.append(opt);
  }
  actSelect.addEventListener("change", persistFromInputs);
  actGroup.append(actSelect);
  container.append(actGroup);

  // --- 8. Include & Exclude Keywords ---
  const inGroup = el(doc, "div", "jobpilot-card");
  inGroup.append(el(doc, "label", "jobpilot-field-label", t("search.includeKeywordsGroup")));
  const inInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  inInput.placeholder = t("search.includePlaceholder");
  inInput.value = profile.includeKeywords.join(", ");
  inInput.addEventListener("input", persistFromInputs);
  inGroup.append(inInput);
  container.append(inGroup);

  const exGroup = el(doc, "div", "jobpilot-card");
  exGroup.append(el(doc, "label", "jobpilot-field-label", t("search.excludeKeywordsGroup")));
  const exInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
  exInput.placeholder = t("search.excludePlaceholder");
  exInput.value = profile.excludeKeywords.join(", ");
  exInput.addEventListener("input", persistFromInputs);
  exGroup.append(exInput);
  container.append(exGroup);

  return container;
};
