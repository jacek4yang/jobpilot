/**
 * Unit tests for the BOSS communication selectors and the pure job-id rules.
 *
 * ============================ HONESTY NOTICE ============================
 * These tests assert agreement between this repository's own code and its own
 * synthetic fixtures. They are NOT evidence about the real BOSS Zhipin site.
 * Entries marked "recon-verified" additionally cite the 2026-09-21 read-only
 * live-site capture, which this file does not itself re-verify.
 * =======================================================================
 */

import { describe, expect, it } from "vitest";
import { extractJobIds, isPlausibleJobId } from "../../../src/adapters/boss/communication/job-id";
import {
  COMMUNICATION_SELECTOR_KEYS,
  COMMUNICATION_SELECTORS,
  communicationSelectorEntries,
  isHeuristic,
  normalizeText,
} from "../../../src/adapters/boss/communication/selectors";

describe("communication selectors", () => {
  it("exposes every declared key", () => {
    for (const key of COMMUNICATION_SELECTOR_KEYS) {
      expect(COMMUNICATION_SELECTORS[key].candidates.length).toBeGreaterThan(0);
    }
    expect(communicationSelectorEntries()).toHaveLength(COMMUNICATION_SELECTOR_KEYS.length);
  });

  it("marks every entry with a confidence and a non-empty note", () => {
    for (const { key, entry } of communicationSelectorEntries()) {
      expect(["fixture-only", "unverified", "recon-verified"]).toContain(entry.confidence);
      expect(entry.note.length, `note for ${key}`).toBeGreaterThan(20);
    }
  });

  it("never claims a selector is verified", () => {
    // The only legal confidences are the three non-verified rungs of the
    // ladder (fixture-only < unverified < recon-verified); a "verified" value
    // would be unrepresentable anyway, and this pins it.
    for (const { entry } of communicationSelectorEntries()) {
      expect(entry.confidence).not.toBe("verified");
    }
  });

  it("classifies the modal-group entries as heuristic", () => {
    expect(isHeuristic(COMMUNICATION_SELECTORS.unknownModal)).toBe(true);
    expect(isHeuristic(COMMUNICATION_SELECTORS.sendButton)).toBe(false);
  });
});

describe("normalizeText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeText("  发送\n  ")).toBe("发送");
  });

  it("treats null and undefined as empty", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("extractJobIds", () => {
  it("keeps purely numeric ids", () => {
    expect(extractJobIds(["12345678"])).toEqual(["12345678"]);
  });

  it("pulls ids out of detail paths", () => {
    expect(extractJobIds(["/job_detail/job-12345.html"])).toEqual(["job-12345"]);
  });

  it("pulls ids out of query strings", () => {
    expect(extractJobIds(["https://www.zhipin.com/x?jobId=abc123&x=1"])).toEqual(["abc123"]);
    expect(extractJobIds(["https://www.zhipin.com/x?jid=77"])).toEqual(["77"]);
  });

  it("deduplicates while preserving order", () => {
    expect(extractJobIds(["12345", "12345", "/job_detail/abc.html", "abc"])).toEqual([
      "12345",
      "abc",
    ]);
  });

  it("rejects a bare token that is not numeric and carries no id pattern", () => {
    // "job-1" LOOKS like an id to a human but contains no extractable evidence:
    // it is neither purely numeric nor inside a recognised href shape. Returning
    // it would mean guessing an id from an arbitrary attribute value.
    expect(extractJobIds(["job-1"])).toEqual([]);
  });

  it("returns nothing rather than inventing an id", () => {
    expect(extractJobIds(["您好，我对这个职位很感兴趣。"])).toEqual([]);
    expect(extractJobIds([""])).toEqual([]);
    expect(extractJobIds([])).toEqual([]);
  });
});

describe("isPlausibleJobId", () => {
  it("accepts id-shaped values", () => {
    expect(isPlausibleJobId("job-12345")).toBe(true);
    expect(isPlausibleJobId("12345678")).toBe(true);
    expect(isPlausibleJobId("abc_DEF-9")).toBe(true);
  });

  it("rejects text, blanks and over-long values", () => {
    expect(isPlausibleJobId("")).toBe(false);
    expect(isPlausibleJobId("后端开发工程师")).toBe(false);
    expect(isPlausibleJobId("job 12345")).toBe(false);
    expect(isPlausibleJobId("a".repeat(65))).toBe(false);
  });
});
