import { describe, expect, it } from "vitest";
import { extractConcerns } from "../../../src/adapters/boss/concerns";

describe("Concern extraction", () => {
  it("detects potential discussion points with calm reminder wording", () => {
    const text = "岗位为项目驻场开发，要求适应加班与大小周工作制";
    const concerns = extractConcerns(text);

    expect(concerns.some((c) => c.includes("驻场/外派"))).toBe(true);
    expect(concerns.some((c) => c.includes("单休") || c.includes("大小周"))).toBe(true);
    expect(concerns.some((c) => c.includes("适应加班"))).toBe(true);
  });

  it("does not trigger when concerns are absent", () => {
    const text = "纯自研业务，早九晚六标准工时，团队氛围好";
    const concerns = extractConcerns(text);
    expect(concerns).toEqual([]);
  });
});
