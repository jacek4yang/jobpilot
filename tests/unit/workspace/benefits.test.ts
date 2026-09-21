import { describe, expect, it } from "vitest";
import { extractBenefits } from "../../../src/adapters/boss/benefits";

describe("Benefits extraction", () => {
  it("extracts explicit benefits mentioned in text", () => {
    const text = `
      岗位职责：负责系统架构
      福利待遇：
      1. 入职即购买五险一金
      2. 实行周末双休制度，带薪年假10天
      3. 年终奖丰厚（14薪），定期体检与弹性工作打卡
    `;

    const benefits = extractBenefits(text);
    expect(benefits).toContain("五险一金");
    expect(benefits).toContain("双休");
    expect(benefits).toContain("年终奖");
    expect(benefits).toContain("带薪年假");
    expect(benefits).toContain("定期体检");
    expect(benefits).toContain("弹性工作");
  });

  it("returns empty array when no explicit evidence is found", () => {
    const text = "单纯的职位要求，没有任何福利条款描述";
    const benefits = extractBenefits(text);
    expect(benefits).toEqual([]);
  });
});
