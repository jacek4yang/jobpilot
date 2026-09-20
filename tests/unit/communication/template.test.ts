import { describe, expect, it } from "vitest";
import {
  createTemplate,
  renderTemplate,
  selectTemplate,
  TEMPLATE_PRESETS,
  TEMPLATE_VARIABLES,
  validateTemplateContent,
} from "../../../src/domain/communication/template";
import type { JobDetail } from "../../../src/domain/job/job";
import { asCompanyId, asJobId, asPlatformId, asRecruiterId } from "../../../src/domain/support/ids";

const NOW = 1_700_000_000_000;

const job = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  id: asJobId("job-1"),
  platform: asPlatformId("boss"),
  title: "后端开发工程师",
  companyName: "示例科技",
  locationRaw: "北京·朝阳区",
  salaryRaw: "20-35K",
  idIsPlatformNative: true,
  company: { id: asCompanyId("示例科技"), name: "示例科技" },
  salary: { period: "month", raw: "20-35K", parsed: true, min: 20, max: 35 },
  location: { city: "北京", raw: "北京·朝阳区" },
  education: "bachelor",
  experience: "3-5",
  description: "负责后端开发",
  requirements: [],
  skills: ["Rust"],
  recruiters: [{ id: asRecruiterId("zhangsan"), name: "张三", title: "招聘经理" }],
  capturedAt: NOW,
  ...overrides,
});

const context = (overrides: Partial<JobDetail> = {}) => ({ job: job(overrides) });

describe("message templates", () => {
  describe("rendering", () => {
    it("renders the job title", () => {
      const result = renderTemplate("您好，我想应聘{{jobTitle}}", context());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text).toBe("您好，我想应聘后端开发工程师");
    });

    it("renders the company", () => {
      const result = renderTemplate("您好{{company}}", context());
      if (result.ok) expect(result.text).toBe("您好示例科技");
    });

    it("renders the recruiter", () => {
      const result = renderTemplate("{{recruiter}}您好", context());
      if (result.ok) expect(result.text).toBe("张三您好");
    });

    it("tolerates whitespace inside the braces", () => {
      const result = renderTemplate("{{ jobTitle }}", context());
      if (result.ok) expect(result.text).toBe("后端开发工程师");
    });

    it("renders the same variable more than once", () => {
      const result = renderTemplate("{{jobTitle}} - {{jobTitle}}", context());
      if (result.ok) expect(result.text).toBe("后端开发工程师 - 后端开发工程师");
    });

    it("reports which variables were used", () => {
      const result = renderTemplate("{{jobTitle}} at {{company}}", context());
      if (result.ok) expect(result.usedVariables).toEqual(["jobTitle", "company"]);
    });

    it("trims the rendered result", () => {
      const result = renderTemplate("  {{jobTitle}}  ", context());
      if (result.ok) expect(result.text).toBe("后端开发工程师");
    });
  });

  describe("refusing to fabricate", () => {
    it("fails when the recruiter is unavailable rather than inventing one", () => {
      const result = renderTemplate("{{recruiter}}您好", context({ recruiters: [] }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("missing-variable");
    });

    it("fails when the company name is blank", () => {
      const result = renderTemplate(
        "{{company}}",
        context({ company: { id: asCompanyId("x"), name: "   " } }),
      );
      expect(result.ok).toBe(false);
    });

    it("fails on an unknown variable instead of emitting it verbatim", () => {
      const result = renderTemplate("{{salary}}", context());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unknown-variable");
        expect(result.detail).toContain("salary");
      }
    });

    it("fails on empty content", () => {
      expect(renderTemplate("", context()).ok).toBe(false);
      expect(renderTemplate("   ", context()).ok).toBe(false);
    });

    it("lists the supported variables in the error", () => {
      const result = renderTemplate("{{nope}}", context());
      if (!result.ok) {
        for (const variable of TEMPLATE_VARIABLES) {
          expect(result.detail).toContain(variable);
        }
      }
    });
  });

  describe("editor-time validation", () => {
    it("accepts a template using only known variables", () => {
      expect(validateTemplateContent("{{jobTitle}} {{company}}").ok).toBe(true);
    });

    it("rejects an unknown variable before a job is involved", () => {
      const result = validateTemplateContent("{{whatever}}");
      expect(result.ok).toBe(false);
    });

    it("rejects empty content", () => {
      expect(validateTemplateContent("").ok).toBe(false);
    });
  });

  describe("selection", () => {
    const templates = [
      createTemplate({ id: "a", name: "A", content: "a" }),
      createTemplate({ id: "b", name: "B", content: "b", isDefault: true }),
      createTemplate({ id: "c", name: "C", content: "c", enabled: false }),
    ];

    it("prefers the default", () => {
      expect(selectTemplate(templates)?.id).toBe("b");
    });

    it("honours an explicit preference", () => {
      expect(selectTemplate(templates, "a")?.id).toBe("a");
    });

    it("ignores a disabled template", () => {
      expect(selectTemplate(templates, "c")?.id).toBe("b");
    });

    it("falls back to the first enabled template", () => {
      const noDefault = [createTemplate({ id: "x", name: "X", content: "x" })];
      expect(selectTemplate(noDefault)?.id).toBe("x");
    });

    it("returns undefined when nothing is usable, so no message is sent", () => {
      expect(selectTemplate([])).toBeUndefined();
      expect(
        selectTemplate([createTemplate({ id: "z", name: "Z", content: "z", enabled: false })]),
      ).toBeUndefined();
    });
  });

  describe("presets", () => {
    it("starts with a blank preset and contains no industry keywords", () => {
      expect(TEMPLATE_PRESETS[0]?.id).toBe("blank");
      expect(TEMPLATE_PRESETS[0]?.content).toBe("");
    });

    it("gives every non-blank preset content that passes validation", () => {
      for (const preset of TEMPLATE_PRESETS) {
        if (preset.id === "blank") continue;
        expect(validateTemplateContent(preset.content).ok).toBe(true);
      }
    });
  });
});
