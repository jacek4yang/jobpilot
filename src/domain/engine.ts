import type { JobDetail } from "./job/job";
import {
  type Evaluation,
  type Rule,
  type RuleContext,
  type RuleEngineConfig,
  type RuleReason,
  type RuleResult,
} from "./rule";
import { createHardRules, createScoringRules } from "./scoring-rules";

export interface EvaluateInput {
  readonly job: JobDetail;
  readonly context: RuleContext;
}

export interface RuleEngine {
  readonly hardRules: readonly Rule[];
  readonly softRules: readonly Rule[];
  evaluate(input: EvaluateInput): Evaluation;
}

/**
 * Pure, stateless rule engine.
 *
 * Hard rules run first. The first failing hard rule short-circuits the
 * evaluation and produces a rejection carrying every reason gathered so far,
 * so that the decision staysexplainable even when it is negative.
 * Soft rules contribute weighted score and always run to completion.
 */
export const createRuleEngine = (config: RuleEngineConfig): RuleEngine => {
  const hardRules = createHardRules();
  const softRules = createScoringRules(config);

  const evaluate = ({ job, context }: EvaluateInput): Evaluation => {
    const reasons: RuleReason[] = [];

    for (const rule of hardRules) {
      const result = rule.evaluate(job, context);
      reasons.push(result.reason);
      if (!result.passed) {
        return {
          jobId: job.id,
          accepted: false,
          score: 0,
          reasons,
          rejections: [result.reason],
        };
      }
    }

    let score = config.scoring.baseScore;
    for (const rule of softRules) {
      const result: RuleResult = rule.evaluate(job, context);
      score += result.score;
      if (result.score !== 0) reasons.push(result.reason);
    }

    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const accepted = clamped >= config.scoring.acceptThreshold;

    if (!accepted) {
      reasons.push({
        ruleId: "score.threshold",
        kind: "soft",
        delta: 0,
        message: `score ${clamped} is below the accept threshold of ${config.scoring.acceptThreshold}`,
      });
    }

    return { jobId: job.id, accepted, score: clamped, reasons, rejections: [] };
  };

  return { hardRules, softRules, evaluate };
};
