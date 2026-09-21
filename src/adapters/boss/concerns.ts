/**
 * Potential concern / inquiry reminder extraction for BOSS job postings.
 *
 * Scans job description and page tags for terms that deserve attention.
 * Invariants:
 * - Uses calm, non-judgmental wording ("可能需要确认...").
 * - Never labels companies or postings negatively.
 * - Serves as an inquiry reminder for candidate discussion rather than a hard block.
 */

export interface ConcernRule {
  readonly id: string;
  readonly keyword: string;
  readonly reminderText: string;
  readonly patterns: readonly RegExp[];
}

export const KNOWN_CONCERN_RULES: readonly ConcernRule[] = [
  {
    id: "waibao",
    keyword: "外包",
    reminderText: "页面提到了“外包”，可以在沟通时确认是否为驻场项目或外包编制。",
    patterns: [/外包/i, /人力外包/i, /项目外包/i, /供应商编制/i],
  },
  {
    id: "zhuchang",
    keyword: "驻场",
    reminderText: "页面提到了“驻场/外派”，可以在沟通时确认具体工作地点与出差安排。",
    patterns: [/驻场/i, /外派/i, /客户现场/i, /派驻/i],
  },
  {
    id: "work-schedule",
    keyword: "工作制",
    reminderText: "页面提到“单休”或“大小周”，建议关注实际休息制度。",
    patterns: [/大小周/i, /单休/i, /单双休/i, /隔周休/i, /做六休一/i],
  },
  {
    id: "overtime",
    keyword: "加班情况",
    reminderText: "页面提到了“抗压”或“适应加班”，沟通时可了解团队平时的节奏。",
    patterns: [/适应加班/i, /能接受加班/i, /抗压能力强/i, /弹性加班/i, /高强度/i],
  },
  {
    id: "sales-nature",
    keyword: "岗位性质",
    reminderText: "页面提到了销售或电销相关内容，可确认具体业绩考核与业务模式。",
    patterns: [/电话销售/i, /电销/i, /地推/i, /销售性质/i, /业绩提成/i],
  },
  {
    id: "salary-negotiable",
    keyword: "薪资结构",
    reminderText: "薪资包含绩效或提成比例，沟通时可详细了解底薪与浮动比例。",
    patterns: [/薪资面议/i, /无责底薪.*提成/i, /绩效占比/i],
  },
];

/**
 * Extracts potential concerns / inquiry reminders from text content.
 * Returns array of calm reminder strings.
 */
export const extractConcerns = (text: string): readonly string[] => {
  if (!text || text.trim().length === 0) return [];
  const reminders: string[] = [];

  for (const rule of KNOWN_CONCERN_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      reminders.push(rule.reminderText);
    }
  }

  return reminders;
};
