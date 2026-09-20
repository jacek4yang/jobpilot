import { describe, expect, it } from "vitest";
import {
  countOutgoingMessages,
  isSameConversation,
  type ChatIdentity,
  matchChatIdentity,
  normalizeIdentityText,
  normalizeMessageText,
} from "../../../src/domain/communication/identity";

const chat = (text: string, jobIds: readonly string[] = []): ChatIdentity => ({ text, jobIds });

describe("chat identity matching", () => {
  describe("normalisation", () => {
    it("strips whitespace and separators", () => {
      expect(normalizeIdentityText("Backend · Engineer")).toBe("backendengineer");
      expect(normalizeIdentityText("A B\tC")).toBe("abc");
    });

    it("strips exactly one company legal-form suffix, longest first", () => {
      // `示例科技有限公司` only ends with `有限公司`.
      expect(normalizeIdentityText("示例科技有限公司")).toBe("示例科技");
      // Both longer legal forms reduce to the same core name, which is the
      // property that matters: the same company must not normalise two ways.
      expect(normalizeIdentityText("示例股份有限公司")).toBe("示例");
      expect(normalizeIdentityText("示例有限责任公司")).toBe("示例");
    });

    it("does not strip a suffix that is not at the end", () => {
      expect(normalizeIdentityText("有限公司示例")).toBe("有限公司示例");
    });

    it("handles undefined", () => {
      expect(normalizeIdentityText(undefined)).toBe("");
    });
  });

  describe("job id precedence", () => {
    it("matches when the job id is present in the conversation", () => {
      const verdict = matchChatIdentity({ jobId: "abc123" }, chat("anything", ["abc123"]));
      expect(verdict.kind).toBe("match");
    });

    it("rejects when the conversation carries a different job id", () => {
      const verdict = matchChatIdentity({ jobId: "abc123" }, chat("Backend Engineer", ["other999"]));
      expect(verdict.kind).toBe("mismatch");
      if (verdict.kind === "mismatch") expect(verdict.reason).toContain("abc123");
    });

    it("rejects a different job id even when the text matches, to avoid conflation", () => {
      // Two postings at the same company can share a title; the id is decisive.
      const verdict = matchChatIdentity(
        { jobId: "abc123", title: "Backend Engineer", company: "示例科技" },
        chat("示例科技 Backend Engineer", ["other999"]),
      );
      expect(verdict.kind).toBe("mismatch");
    });

    it("matches on the id alone when nothing corroborates it", () => {
      const verdict = matchChatIdentity({ jobId: "abc123" }, chat("recruiter header", ["abc123"]));
      expect(verdict.kind).toBe("match");
    });
  });

  describe("text-only matching", () => {
    it("requires corroboration beyond the title", () => {
      const verdict = matchChatIdentity(
        { title: "Backend Engineer" },
        chat("Backend Engineer"),
      );
      expect(verdict.kind).toBe("insufficient");
    });

    it("matches when the title and the company both appear", () => {
      const verdict = matchChatIdentity(
        { title: "Backend Engineer", company: "示例科技" },
        chat("Backend Engineer 示例科技有限公司"),
      );
      expect(verdict.kind).toBe("match");
    });

    it("matches when the title and the recruiter both appear", () => {
      const verdict = matchChatIdentity(
        { title: "Backend Engineer", recruiter: "张三" },
        chat("Backend Engineer 张三"),
      );
      expect(verdict.kind).toBe("match");
    });

    it("is insufficient when the title is absent", () => {
      const verdict = matchChatIdentity(
        { title: "Backend Engineer", company: "示例科技" },
        chat("示例科技 招聘专员"),
      );
      expect(verdict.kind).toBe("insufficient");
    });

    it("never matches on an empty conversation", () => {
      expect(matchChatIdentity({ title: "X", company: "Y" }, chat("")).kind).toBe("insufficient");
    });

    it("is insufficient when there is no identity to compare at all", () => {
      expect(matchChatIdentity({}, chat("anything")).kind).toBe("insufficient");
    });
  });

  describe("strict mode", () => {
    it("requires a job id when asked", () => {
      const verdict = matchChatIdentity(
        { title: "Backend Engineer", company: "示例科技" },
        chat("Backend Engineer 示例科技"),
        { requireJobIdMatch: true },
      );
      expect(verdict.kind).toBe("insufficient");
    });
  });

  describe("conversation switching", () => {
    it("detects a switch by header text", () => {
      expect(isSameConversation(chat("Alice"), chat("Bob"))).toBe(false);
      expect(isSameConversation(chat("Alice"), chat("Alice"))).toBe(true);
    });

    it("detects a switch by job id", () => {
      expect(isSameConversation(chat("h", ["a"]), chat("h", ["b"]))).toBe(false);
    });

    it("treats missing ids on either side as inconclusive rather than a switch", () => {
      expect(isSameConversation(chat("h", []), chat("h", ["a"]))).toBe(true);
      expect(isSameConversation(chat("h", ["a"]), chat("h", []))).toBe(true);
    });

    it("ignores insignificant formatting differences", () => {
      expect(isSameConversation(chat("示例科技有限公司"), chat("示例科技"))).toBe(true);
    });
  });
});

describe("outgoing message counting", () => {
  it("counts exact matches", () => {
    expect(countOutgoingMessages(["hello", "hi", "hello"], "hello")).toBe(2);
  });

  it("ignores whitespace differences", () => {
    expect(countOutgoingMessages(["hello   world"], "hello world")).toBe(1);
    expect(countOutgoingMessages(["hello\nworld"], "hello world")).toBe(1);
  });

  it("returns zero for empty text rather than counting everything", () => {
    expect(countOutgoingMessages(["a", "b"], "")).toBe(0);
    expect(countOutgoingMessages(["a", "b"], "   ")).toBe(0);
  });

  it("does not match a partial message", () => {
    expect(countOutgoingMessages(["hello there"], "hello")).toBe(0);
  });

  it("returns zero for an empty message list", () => {
    expect(countOutgoingMessages([], "hello")).toBe(0);
  });

  it("normalises message text for comparison", () => {
    expect(normalizeMessageText("  a   b  ")).toBe("a b");
    expect(normalizeMessageText(undefined)).toBe("");
  });
});
