import { describe, expect, it } from "vitest";
import {
  allowsProceeding,
  evaluateActivity,
  parseActivityLabel,
  pickMostConservativeActivity,
} from "../../../src/domain/recruiter/activity";

const labels = (values: readonly string[]) => pickMostConservativeActivity(values);

describe("recruiter activity", () => {
  describe("exact label parsing", () => {
    const cases: readonly (readonly [string, string, number])[] = [
      ["在线", "online", 0],
      ["当前在线", "online", 0],
      ["刚刚活跃", "today", 0],
      ["今日活跃", "today", 0],
      ["今日在线", "today", 0],
      ["昨天活跃", "within_3_days", 1],
      ["昨日在线", "within_3_days", 1],
      ["30分钟前活跃", "today", 0],
      ["3天前活跃", "within_3_days", 3],
      ["近7天活跃", "within_7_days", 7],
      ["本周活跃", "within_7_days", 7],
      ["本月活跃", "within_30_days", 30],
      ["半年前活跃", "inactive", Number.POSITIVE_INFINITY],
      ["离线", "inactive", Number.POSITIVE_INFINITY],
    ];

    for (const [label, recency, days] of cases) {
      it(`parses "${label}" as ${recency}`, () => {
        const parsed = parseActivityLabel(label);
        expect(parsed?.recency).toBe(recency);
        expect(parsed?.days).toBe(days);
        expect(parsed?.label).toBe(label);
      });
    }

    it("marks only explicit online labels as online", () => {
      expect(parseActivityLabel("在线")?.online).toBe(true);
      expect(parseActivityLabel("今日活跃")?.online).toBe(false);
      expect(parseActivityLabel("刚刚活跃")?.online).toBe(false);
    });
  });

  describe("refusing to guess", () => {
    it("rejects prose containing an activity word", () => {
      // The reference scanned whole regions for these substrings; a sentence
      // must never be mistaken for a status label.
      expect(parseActivityLabel("我们希望你一周内到岗")).toBeUndefined();
      expect(parseActivityLabel("该职位长期有效")).toBeUndefined();
      expect(parseActivityLabel("在线教育行业")).toBeUndefined();
    });

    it("rejects empty and undefined input", () => {
      expect(parseActivityLabel("")).toBeUndefined();
      expect(parseActivityLabel("   ")).toBeUndefined();
      expect(parseActivityLabel(undefined)).toBeUndefined();
      expect(parseActivityLabel(null)).toBeUndefined();
    });

    it("rejects an unknown label", () => {
      expect(parseActivityLabel("状态未知")).toBeUndefined();
      expect(parseActivityLabel("活跃")).toBeUndefined();
    });
  });

  describe("contradictory labels", () => {
    it("chooses the least active reading", () => {
      const picked = labels(["在线", "30天前活跃"]);
      expect(picked?.recency).toBe("within_30_days");
    });

    it("prefers not-online when recency ties", () => {
      const picked = labels(["在线", "今日活跃"]);
      expect(picked?.online).toBe(false);
    });

    it("returns undefined when no label parses", () => {
      expect(labels(["nonsense", "other"])).toBeUndefined();
    });

    it("ignores unparseable labels when a valid one exists", () => {
      const picked = labels(["nonsense", "在线"]);
      expect(picked?.recency).toBe("online");
    });
  });

  describe("preference evaluation", () => {
    it("passes everything when the preference is any", () => {
      const verdict = evaluateActivity(undefined, "any", true);
      expect(verdict.kind).toBe("pass");
    });

    it("passes an online recruiter for the online preference", () => {
      const verdict = evaluateActivity(parseActivityLabel("在线"), "online", true);
      expect(verdict.kind).toBe("pass");
    });

    it("skips an offline recruiter for the online preference", () => {
      const verdict = evaluateActivity(parseActivityLabel("3天前活跃"), "online", true);
      expect(verdict.kind).toBe("skip");
    });

    it("honours the day limit", () => {
      expect(evaluateActivity(parseActivityLabel("5天前活跃"), "within_7_days", true).kind).toBe(
        "pass",
      );
      expect(evaluateActivity(parseActivityLabel("10天前活跃"), "within_7_days", true).kind).toBe(
        "skip",
      );
    });

    it("skips an inactive recruiter even under the loosest preference", () => {
      expect(evaluateActivity(parseActivityLabel("半年前活跃"), "within_30_days", true).kind).toBe(
        "skip",
      );
    });

    it("reports unknown activity distinctly rather than silently passing", () => {
      const verdict = evaluateActivity(undefined, "today", true);
      expect(verdict.kind).toBe("unknown");
      expect(verdict.reason).toContain("could not be read");
    });
  });

  describe("unknown-activity policy", () => {
    it("blocks when the policy is to skip unknown", () => {
      expect(allowsProceeding({ kind: "unknown", reason: "" }, true)).toBe(false);
    });

    it("allows when the policy is to permit unknown", () => {
      expect(allowsProceeding({ kind: "unknown", reason: "" }, false)).toBe(true);
    });

    it("always blocks an explicit skip", () => {
      expect(allowsProceeding({ kind: "skip", reason: "" }, false)).toBe(false);
    });

    it("always allows an explicit pass", () => {
      expect(allowsProceeding({ kind: "pass", reason: "" }, false)).toBe(true);
    });
  });
});
