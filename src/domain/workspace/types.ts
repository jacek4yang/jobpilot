/**
 * Personal Job Workspace Domain Types.
 *
 * Core entities and value objects for the BOSS-native personal workspace:
 * - Personal preference (explicit human feeling: 喜欢 / 有点兴趣 / 再看看 / 不适合)
 * - Lightweight pipeline stages (刚发现 -> 喜欢 -> 准备沟通 -> 已沟通 -> 有回复 -> 待面试 -> Offer -> 已结束)
 * - Rich annotations (notes, tags, question checklists)
 * - Normalised job snapshots (platform-derived data)
 * - Interview records and timeline events
 * - Search sessions and custom tags
 */

export type PersonalPreference = "favorite" | "interested" | "maybe" | "not-interested" | "unset";

export const PREFERENCE_LABELS: Readonly<Record<PersonalPreference, string>> = {
  favorite: "💗 很喜欢",
  interested: "🩷 有点兴趣",
  maybe: "☆ 再看看",
  "not-interested": "— 不适合",
  unset: "未标记",
};

export type JobStage =
  | "discovered"
  | "favorite"
  | "considering"
  | "ready-to-contact"
  | "contacted"
  | "replied"
  | "interview-planned"
  | "interviewed"
  | "offer"
  | "not-interested"
  | "closed";

export const STAGE_LABELS: Readonly<Record<JobStage, string>> = {
  discovered: "刚发现",
  favorite: "喜欢",
  considering: "再看看",
  "ready-to-contact": "准备沟通",
  contacted: "已沟通",
  replied: "有回复",
  "interview-planned": "待面试",
  interviewed: "已面试",
  offer: "收到 Offer",
  "not-interested": "不考虑",
  closed: "已结束",
};

export const PIPELINE_STAGES: readonly JobStage[] = [
  "favorite",
  "considering",
  "ready-to-contact",
  "contacted",
  "replied",
  "interview-planned",
  "interviewed",
  "offer",
  "closed",
];

export interface QuestionItem {
  readonly id: string;
  readonly text: string;
  readonly answered: boolean;
  readonly answer?: string | undefined;
}

export interface JobAnnotation {
  readonly jobId: string;
  readonly preference: PersonalPreference;
  readonly note?: string | undefined;
  readonly positiveTags: readonly string[];
  readonly concernTags: readonly string[];
  readonly questionTags: readonly string[];
  readonly customTags: readonly string[];
  readonly questions: readonly QuestionItem[];
  readonly pinned: boolean;
  readonly updatedAt: number;
}

export interface StoredJob {
  readonly id: string;
  readonly platform: "boss";
  readonly title: string;
  readonly companyName: string;
  readonly salaryRaw?: string | undefined;
  readonly minSalaryK?: number | undefined;
  readonly maxSalaryK?: number | undefined;
  readonly locationRaw?: string | undefined;
  readonly city?: string | undefined;
  readonly district?: string | undefined;
  readonly experience?: string | undefined;
  readonly education?: string | undefined;
  readonly companyScale?: string | undefined;
  readonly industry?: string | undefined;
  readonly financingStage?: string | undefined;
  readonly recruiterName?: string | undefined;
  readonly recruiterRole?: string | undefined;
  readonly recruiterActivity?: string | undefined;
  readonly description?: string | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly requirements?: readonly string[] | undefined;
  readonly benefits?: readonly string[] | undefined;
  readonly potentialConcerns?: readonly string[] | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly sourceFingerprint?: string | undefined;
}

export interface StageHistoryItem {
  readonly stage: JobStage;
  readonly timestamp: number;
  readonly note?: string | undefined;
}

export interface PipelineRecord {
  readonly jobId: string;
  readonly stage: JobStage;
  readonly updatedAt: number;
  readonly history: readonly StageHistoryItem[];
}

export interface InterviewRecord {
  readonly id: string;
  readonly jobId: string;
  readonly scheduledAt?: number | undefined;
  readonly format?: "online" | "onsite" | "phone" | "unknown" | undefined;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
  readonly result?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TimelineEvent {
  readonly id: string;
  readonly jobId: string;
  readonly type: "seen" | "preference" | "stage" | "note" | "interview" | "message";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly timestamp: number;
}

export interface SearchSession {
  readonly id: string;
  readonly profileId: string;
  readonly querySummary: string;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly jobsSeen: number;
  readonly accepted: number;
  readonly manuallyLiked: number;
}

export interface CustomTag {
  readonly id: string;
  readonly name: string;
  readonly color?: string | undefined;
  readonly createdAt: number;
}

export const BUILTIN_POSITIVE_TAGS: readonly string[] = [
  "薪资不错",
  "工作内容喜欢",
  "技术方向合适",
  "地点方便",
  "公司不错",
  "成长空间",
  "福利不错",
  "BOSS 活跃",
];

export const BUILTIN_CONCERN_TAGS: readonly string[] = [
  "可能外包",
  "可能驻场",
  "单双休不明确",
  "加班情况未知",
  "薪资结构未知",
  "工作地点不确定",
  "JD 信息较少",
];

export const BUILTIN_QUESTION_TAGS: readonly string[] = [
  "是否双休",
  "是否需要加班",
  "是否需要驻场",
  "试用期工资",
  "五险一金",
  "公积金比例",
  "实际办公地点",
  "团队规模",
  "具体工作内容",
  "晋升空间",
  "年终奖",
  "调薪周期",
];

export const createDefaultAnnotation = (jobId: string, now: number): JobAnnotation => ({
  jobId,
  preference: "unset",
  positiveTags: [],
  concernTags: [],
  questionTags: [],
  customTags: [],
  questions: [],
  pinned: false,
  updatedAt: now,
});
