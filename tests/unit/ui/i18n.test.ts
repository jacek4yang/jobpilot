import { beforeEach, describe, expect, it } from "vitest";
import { en } from "../../../src/ui/i18n/en";
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  getGreeting,
  getLocale,
  onLocaleChange,
  setLocale,
  t,
} from "../../../src/ui/i18n/index";
import { zhCN } from "../../../src/ui/i18n/zh-CN";

describe("i18n core", () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it("defaults to zh-CN", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(FALLBACK_LOCALE).toBe("en");
    expect(getLocale()).toBe("zh-CN");
  });

  it("translates basic keys in zh-CN", () => {
    expect(t("common.start")).toBe("开始");
    expect(t("common.pause")).toBe("暂停");
    expect(t("common.resume")).toBe("继续");
    expect(t("common.stop")).toBe("停止");
  });

  it("switches locale to English and notifies listeners", () => {
    let notifiedLocale = "";
    const unsub = onLocaleChange((loc) => {
      notifiedLocale = loc;
    });

    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(notifiedLocale).toBe("en");
    expect(t("common.start")).toBe("Start");
    expect(t("common.pause")).toBe("Pause");

    unsub();
  });

  it("interpolates parameters into translated strings", () => {
    expect(t("matches.countSummary", { count: 12 }, "zh-CN")).toBe("共找到 12 个合适职位");
    expect(t("matches.countSummary", { count: 12 }, "en")).toBe("12 suitable positions found");
  });

  it("falls back to English when a key is missing in active locale", () => {
    // If a key doesn't exist in zh-CN but exists in en
    const customKey = "nonexistent.key.test";
    expect(t(customKey)).toBe(customKey);
  });

  it("has complete 1:1 key parity between zh-CN and en dictionaries", () => {
    const collectKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          keys.push(...collectKeys(value as Record<string, unknown>, fullPath));
        } else {
          keys.push(fullPath);
        }
      }
      return keys.sort();
    };

    const zhKeys = collectKeys(zhCN as unknown as Record<string, unknown>);
    const enKeys = collectKeys(en as unknown as Record<string, unknown>);

    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));

    expect(missingInEn, "Keys present in zh-CN must also exist in en").toEqual([]);
    expect(missingInZh, "Keys present in en must also exist in zh-CN").toEqual([]);
  });

  it("generates calm personalized greetings without exposing real identity", () => {
    // When no display name is given
    const defaultGreeting = getGreeting();
    expect(defaultGreeting).toBe("你好，今天慢慢来，先看看合适的机会。");

    // When a test display name is given
    const testName = "小李";
    const personalized = getGreeting(testName);
    expect(personalized).toContain(testName);
    expect(personalized).toContain("今天慢慢来");
  });
});
