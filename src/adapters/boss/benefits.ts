/**
 * Benefit evidence extraction for BOSS job postings.
 *
 * Scans job description and page tags for explicit benefit phrases.
 * Invariant: Never infers benefits without explicit text evidence.
 */

export interface BenefitRule {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

export const KNOWN_BENEFIT_RULES: readonly BenefitRule[] = [
  {
    id: "wuxian-yijin",
    label: "五险一金",
    patterns: [/五险一金/i, /六险一金/i, /缴纳社保/i, /公积金/i],
  },
  {
    id: "shuangxiu",
    label: "双休",
    patterns: [/周末双休/i, /双休/i, /做五休二/i, /标准工时/i],
  },
  {
    id: "year-end-bonus",
    label: "年终奖",
    patterns: [/年终奖/i, /13薪/i, /十三薪/i, /14薪/i, /十四薪/i, /15薪/i, /十五薪/i, /16薪/i],
  },
  {
    id: "meals",
    label: "餐补 / 免费三餐",
    patterns: [/餐补/i, /包吃/i, /免费三餐/i, /餐饮补贴/i, /提供工作餐/i],
  },
  {
    id: "transport",
    label: "交通补助 / 班车",
    patterns: [/交通补助/i, /交通补贴/i, /班车/i, /免费班车/i, /车补/i],
  },
  {
    id: "housing",
    label: "房补 / 提供住宿",
    patterns: [/房补/i, /住房补贴/i, /包住/i, /提供住宿/i, /人才公寓/i],
  },
  {
    id: "flexible",
    label: "弹性工作",
    patterns: [/弹性工作/i, /弹性打卡/i, /不卡工时/i, /不打卡/i],
  },
  {
    id: "health-check",
    label: "定期体检",
    patterns: [/定期体检/i, /年度体检/i, /员工体检/i, /体检福利/i],
  },
  {
    id: "paid-annual-leave",
    label: "带薪年假",
    patterns: [/带薪年假/i, /带薪假期/i, /法定假期/i],
  },
  {
    id: "supplementary-medical",
    label: "补充医疗保险",
    patterns: [/补充医疗/i, /商业保险/i, /重疾险/i, /意外险/i],
  },
];

/**
 * Extracts explicit benefits mentioned in text content.
 * Returns unique labels only when explicitly detected.
 */
export const extractBenefits = (text: string): readonly string[] => {
  if (!text || text.trim().length === 0) return [];
  const matched: string[] = [];

  for (const rule of KNOWN_BENEFIT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      matched.push(rule.label);
    }
  }

  return matched;
};
