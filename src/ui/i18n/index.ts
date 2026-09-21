/**
 * Lightweight internationalization (i18n) layer for JobPilot.
 *
 * Defaults to `zh-CN` with `en` as fallback.
 * Persists locale choice locally and notifies subscribers upon change.
 */

import { en } from "./en";
import { zhCN } from "./zh-CN";

export type SupportedLocale = "zh-CN" | "en";
export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";
export const FALLBACK_LOCALE: SupportedLocale = "en";

export const SUPPORTED_LOCALES: readonly {
  readonly id: SupportedLocale;
  readonly label: string;
}[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
];

export type TranslationDict = typeof zhCN;

const DICTIONARIES: Record<SupportedLocale, unknown> = {
  "zh-CN": zhCN,
  en,
};

let currentLocale: SupportedLocale = DEFAULT_LOCALE;
const listeners = new Set<(locale: SupportedLocale) => void>();

export const getLocale = (): SupportedLocale => currentLocale;

export const setLocale = (locale: string): void => {
  const next: SupportedLocale = locale === "en" ? "en" : "zh-CN";
  if (currentLocale === next) return;
  currentLocale = next;
  for (const listener of listeners) {
    try {
      listener(currentLocale);
    } catch {
      // Ignore listener errors
    }
  }
};

export const onLocaleChange = (listener: (locale: SupportedLocale) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getNestedValue = (obj: unknown, path: string): string | undefined => {
  if (typeof obj !== "object" || obj === null) return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
};

/**
 * Translates a key path (e.g. "common.pause") with optional interpolation variables.
 */
export const t = (
  key: string,
  params?: Record<string, string | number>,
  localeOverride?: SupportedLocale,
): string => {
  const active = localeOverride ?? currentLocale;
  const primaryDict = DICTIONARIES[active];
  let template = getNestedValue(primaryDict, key);

  if (template === undefined && active !== FALLBACK_LOCALE) {
    const fallbackDict = DICTIONARIES[FALLBACK_LOCALE];
    template = getNestedValue(fallbackDict, key);
  }

  if (template === undefined) {
    return key;
  }

  if (params === undefined) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, placeholder: string) => {
    const value = params[placeholder];
    return value !== undefined ? String(value) : `{${placeholder}}`;
  });
};

/**
 * Helper to get a gentle personalized or default greeting.
 */
export const getGreeting = (displayName?: string): string => {
  const hour = new Date().getHours();
  const trimmed = displayName?.trim();

  if (!trimmed || trimmed === "你好") {
    return t("home.greetingDefault");
  }

  if (hour >= 5 && hour < 12) {
    return t("home.greetingMorning", { name: trimmed });
  }
  if (hour >= 12 && hour < 18) {
    return t("home.greetingAfternoon", { name: trimmed });
  }
  return t("home.greetingEvening", { name: trimmed });
};
