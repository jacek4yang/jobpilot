/**
 * Two-stage job evaluation.
 *
 * Stage A runs on card data only and is cheap: it exists so that obviously
 * unsuitable jobs are never opened, which saves navigation and reduces the
 * chance of tripping rate limits. Stage B runs only on survivors and needs the
 * full detail page.
 *
 * Both stages produce the same explainable shape, so the UI can present a
 * uniform reason list regardless of which stage rejected the job.
 */
import type { JobDetail, JobSummary } from "../job/job";
import type { RecruiterActivity } from "../recruiter/activity";
import { evaluateActivity } from "../recruiter/activity";
import type { ActivityPreference, SearchProfile } from "../search-profile/profile";

export type Stage = "A" | "B";

/**
 * Soft-score weights. Named so the explanation the UI renders and the number
 * the engine computes can never drift apart.
 */
export const SCORE_WEIGHTS = {
  activity: 10,
  salaryAboveTarget: 10,
  companyScale: 5,
} as const;

const ACTIVITY_BONUS = SCORE_WEIGHTS.activity;

export interface StageReason {
  readonly code: string;
  readonly stage: Stage;
  readonly message: string;
  /** Positive pushes toward accept, negative toward reject. */
  readonly delta: number;
}

export type StageOutcome =
  | { readonly kind: "rejected"; readonly reasons: readonly StageReason[] }
  | { readonly kind: "passed"; readonly reasons: readonly StageReason[] };

export interface StageAInput {
  readonly summary: JobSummary;
  readonly profile: SearchProfile;
  /** Job ids already contacted or otherwise finalised. */
  readonly contactedJobIds: ReadonlySet<string>;
  /** Companies the user has excluded. */
  readonly companyBlacklist: readonly string[];
  /** Titles the user has excluded. */
  readonly titleBlacklist: readonly string[];
}

const normalise = (value: string): string => value.trim().toLowerCase();

const containsAny = (haystack: string, needles: readonly string[]): string | undefined => {
  const text = normalise(haystack);
  return needles.find((needle) => needle.trim().length > 0 && text.includes(normalise(needle)));
};

/**
 * Stage A: cheap filtering on data already present in the list.
 *
 * Deliberately conservative about missing data: a card that does not show a
 * salary is not rejected for salary, because the card simply may not render it.
 * Only *positive* evidence rejects.
 */
export const evaluateStageA = (input: StageAInput): StageOutcome => {
  const { summary, profile } = input;
  const reasons: StageReason[] = [];
  const reject = (code: string, message: string): StageOutcome => ({
    kind: "rejected",
    reasons: [...reasons, { code, stage: "A", message, delta: 0 }],
  });

  if (input.contactedJobIds.has(summary.id)) {
    return reject("ALREADY_CONTACTED", "already present in history as contacted");
  }

  const cardText = `${summary.title} ${summary.companyName}`;

  const excluded = containsAny(cardText, profile.excludeKeywords);
  if (excluded !== undefined) {
    return reject("FILTER_REJECTED", `contains excluded keyword "${excluded}"`);
  }

  const blacklistedCompany = containsAny(summary.companyName, input.companyBlacklist);
  if (blacklistedCompany !== undefined) {
    return reject("FILTER_REJECTED", `company matches blacklist entry "${blacklistedCompany}"`);
  }

  const blacklistedTitle = containsAny(summary.title, input.titleBlacklist);
  if (blacklistedTitle !== undefined) {
    return reject("FILTER_REJECTED", `title matches blacklist entry "${blacklistedTitle}"`);
  }

  // Cities are checked at stage A because the card always carries a location.
  if (profile.cities.length > 0) {
    const city = summary.locationRaw.trim();
    if (city.length > 0) {
      const matches = profile.cities.some((wanted) =>
        normalise(city).startsWith(normalise(wanted).replace(/[市区]$/, "")),
      );
      if (!matches) {
        return reject("FILTER_REJECTED", `location "${city}" is outside the profile's cities`);
      }
      reasons.push({
        code: "location",
        stage: "A",
        message: `location "${city}" matches the profile`,
        delta: 0,
      });
    }
  }

  // Salary is checked only when the card shows a parseable range. A card that
  // lacks salary data must not be rejected on that basis.
  if (profile.salary !== undefined && profile.salary.minK > 0) {
    const parsed = parseSalaryFromCard(summary.salaryRaw);
    if (parsed !== undefined && parsed.max < profile.salary.minK) {
      return reject(
        "FILTER_REJECTED",
        `salary ${summary.salaryRaw} is below the profile minimum of ${profile.salary.minK}K`,
      );
    }
  }

  return { kind: "passed", reasons };
};

/** Extracts `min-max` from a card salary string; `undefined` when unparseable. */
const parseSalaryFromCard = (raw: string): { min: number; max: number } | undefined => {
  const match = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Kk千]/.exec(raw);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const a = Number.parseFloat(match[1]);
    const b = Number.parseFloat(match[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const single = /(\d+(?:\.\d+)?)\s*[Kk千]/.exec(raw);
  if (single?.[1] !== undefined) {
    const value = Number.parseFloat(single[1]);
    return { min: value, max: value };
  }
  return undefined;
};

export interface StageBInput {
  readonly job: JobDetail;
  readonly profile: SearchProfile;
  readonly activity?: RecruiterActivity;
  readonly activityPreference: ActivityPreference;
  readonly skipUnknownActivity: boolean;
  /** Keywords the user wants rewarded, with weights. */
  readonly preferredSkills: readonly { readonly keyword: string; readonly weight: number }[];
  readonly preferredIndustries: readonly { readonly keyword: string; readonly weight: number }[];
  readonly baseScore: number;
  readonly acceptThreshold: number;
}

export interface StageBEvaluation {
  readonly outcome: StageOutcome;
  readonly score: number;
  readonly accepted: boolean;
  readonly reasons: readonly StageReason[];
}

/**
 * Stage B: detail-aware filtering and scoring.
 *
 * Hard rejections are checked before scoring, and a hard rejection short
 * circuits so the user sees the decisive reason rather than a wall of partial
 * scoring.
 */
export const evaluateStageB = (input: StageBInput): StageBEvaluation => {
  const { job, profile } = input;
  const fullText = [job.title, job.description, ...job.skills, ...job.requirements].join("\n");

  const hardReasons: StageReason[] = [];
  const reject = (code: string, message: string): StageBEvaluation => {
    const reasons = [...hardReasons, { code, stage: "B", message, delta: 0 } as StageReason];
    return { outcome: { kind: "rejected", reasons }, score: 0, accepted: false, reasons };
  };

  const excluded = containsAny(fullText, profile.excludeKeywords);
  if (excluded !== undefined) {
    return reject("FILTER_REJECTED", `description contains excluded keyword "${excluded}"`);
  }

  if (profile.includeKeywords.length > 0) {
    const matched = containsAny(fullText, profile.includeKeywords);
    if (matched === undefined) {
      return reject(
        "FILTER_REJECTED",
        `matches none of the required keywords [${profile.includeKeywords.join(", ")}]`,
      );
    }
    hardReasons.push({
      code: "include-keywords",
      stage: "B",
      message: `matched required keyword "${matched}"`,
      delta: 0,
    });
  }

  if (profile.degree !== undefined && profile.degree.length > 0) {
    const degree = job.degreeLabel;
    if (degree !== undefined && degree.length > 0) {
      const anyDegree = profile.degree.includes("不限");
      if (!anyDegree && !profile.degree.some((wanted) => wanted === degree)) {
        return reject(
          "FILTER_REJECTED",
          `requires ${degree}, which is outside the profile's accepted degrees`,
        );
      }
      hardReasons.push({
        code: "degree",
        stage: "B",
        message: `degree requirement "${degree}" is accepted`,
        delta: 0,
      });
    }
  }

  if (profile.experience !== undefined && profile.experience.length > 0) {
    const experience = job.experienceLabel;
    if (experience !== undefined && experience.length > 0) {
      const anyExperience = profile.experience.includes("经验不限");
      if (!anyExperience && !profile.experience.some((wanted) => wanted === experience)) {
        return reject(
          "FILTER_REJECTED",
          `requires ${experience}, which is outside the profile's accepted experience bands`,
        );
      }
    }
  }

  const activityVerdict = evaluateActivity(
    input.activity,
    input.activityPreference,
    input.skipUnknownActivity,
  );
  if (activityVerdict.kind === "skip") {
    return reject("FILTER_REJECTED", activityVerdict.reason);
  }

  // --- Soft scoring ---------------------------------------------------------
  // `score` must always equal `baseScore` plus the sum of every delta pushed
  // below. Any contribution that is reported must actually be applied, or the
  // explanation the user sees would overstate the score.
  const reasons: StageReason[] = [...hardReasons];
  let score = input.baseScore;

  if (activityVerdict.kind === "pass") {
    score += ACTIVITY_BONUS;
    reasons.push({
      code: "activity",
      stage: "B",
      message: activityVerdict.reason,
      delta: ACTIVITY_BONUS,
    });
  }

  const skillText = normalise([...job.skills, job.description].join("\n"));
  for (const skill of input.preferredSkills) {
    if (skillText.includes(normalise(skill.keyword))) {
      score += skill.weight;
      reasons.push({
        code: `skill:${skill.keyword}`,
        stage: "B",
        message: `preferred skill "${skill.keyword}" present`,
        delta: skill.weight,
      });
    }
  }

  const industry = job.company.industry;
  if (industry !== undefined) {
    for (const preferred of input.preferredIndustries) {
      if (normalise(industry).includes(normalise(preferred.keyword))) {
        score += preferred.weight;
        reasons.push({
          code: `industry:${preferred.keyword}`,
          stage: "B",
          message: `industry "${industry}" matches preference "${preferred.keyword}"`,
          delta: preferred.weight,
        });
      }
    }
  }

  if (profile.salary !== undefined && profile.salary.minK > 0 && job.salary.parsed) {
    const actual = job.salary.min ?? 0;
    if (actual > profile.salary.minK) {
      score += SCORE_WEIGHTS.salaryAboveTarget;
      reasons.push({
        code: "salary-above-target",
        stage: "B",
        message: `salary ${job.salary.raw} is above the target minimum of ${profile.salary.minK}K`,
        delta: SCORE_WEIGHTS.salaryAboveTarget,
      });
    }
  }

  if (profile.companyScales !== undefined && profile.companyScales.length > 0) {
    const scale = job.company.size;
    if (scale !== undefined && profile.companyScales.some((wanted) => wanted === scale)) {
      score += SCORE_WEIGHTS.companyScale;
      reasons.push({
        code: "company-scale",
        stage: "B",
        message: `company scale ${scale} matches preference`,
        delta: SCORE_WEIGHTS.companyScale,
      });
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const accepted = clamped >= input.acceptThreshold;

  if (!accepted) {
    reasons.push({
      code: "score-threshold",
      stage: "B",
      message: `score ${clamped} is below the accept threshold of ${input.acceptThreshold}`,
      delta: 0,
    });
  }

  return {
    outcome: accepted ? { kind: "passed", reasons } : { kind: "rejected", reasons },
    score: clamped,
    accepted,
    reasons,
  };
};
