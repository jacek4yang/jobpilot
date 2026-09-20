import type { JobDetail } from "./job/job";
import { normalizeCity } from "./job/location";
import { formatSalary } from "./job/salary";
import {
  hardPass,
  type Rule,
  type RuleContext,
  type RuleResult,
  rejection,
} from "./rule";

/** Case-insensitive substring search over the job's full text surface. */
export const jobText = (job: JobDetail): string =>
  [job.title, job.companyName, job.description, ...job.skills, ...job.requirements]
    .join("\n")
    .toLowerCase();

export const locationRule: Rule = {
  id: "hard.location",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const wanted = context.config.hard.cities;
    if (wanted.length === 0) return hardPass(this.id, "no city filter configured");
    if (job.location.city.length === 0) {
      // Unknown location is not evidence of a mismatch: do not hard-reject.
      return hardPass(this.id, "location unknown, deferring to score");
    }
    const normalizedJobCity = normalizeCity(job.location.city);
    const match = wanted.some((city) => normalizeCity(city) === normalizedJobCity);
    return match
      ? hardPass(this.id, `city "${job.location.city}" is in the preferred list`)
      : rejection(this.id, `city "${job.location.city}" is not in [${wanted.join(", ")}]`);
  },
};

export const salaryRule: Rule = {
  id: "hard.salary",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const { minSalaryK, maxSalaryK } = context.config.hard;
    if (!job.salary.parsed || job.salary.min === undefined || job.salary.max === undefined) {
      return hardPass(this.id, "salary not parseable, deferring to score");
    }
    const rendered = formatSalary(job.salary);
    if (minSalaryK > 0 && job.salary.max < minSalaryK) {
      return rejection(this.id, `salary ${rendered} is below the minimum of ${minSalaryK}K`);
    }
    if (maxSalaryK > 0 && job.salary.min > maxSalaryK) {
      return rejection(this.id, `salary ${rendered} is above the maximum of ${maxSalaryK}K`);
    }
    return hardPass(this.id, `salary ${rendered} is within range`);
  },
};

export const educationRule: Rule = {
  id: "hard.education",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const wanted = context.config.hard.education;
    if (wanted.length === 0) return hardPass(this.id, "no education filter configured");
    if (job.education === "unknown") {
      return hardPass(this.id, "education requirement unknown, deferring to score");
    }
    const match = wanted.includes(job.education);
    return match
      ? hardPass(this.id, `education "${job.education}" is accepted`)
      : rejection(this.id, `education requirement "${job.education}" is not in [${wanted.join(", ")}]`);
  },
};

export const experienceRule: Rule = {
  id: "hard.experience",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const wanted = context.config.hard.experience;
    if (wanted.length === 0) return hardPass(this.id, "no experience filter configured");
    if (job.experience === "unknown") {
      return hardPass(this.id, "experience requirement unknown, deferring to score");
    }
    const match = wanted.includes(job.experience);
    return match
      ? hardPass(this.id, `experience "${job.experience}" is accepted`)
      : rejection(this.id, `experience requirement "${job.experience}" is not in [${wanted.join(", ")}]`);
  },
};

export const keywordRule: Rule = {
  id: "hard.keywords",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const { includeKeywords, excludeKeywords } = context.config.hard;
    const text = jobText(job);

    const blocked = excludeKeywords.filter((keyword) => text.includes(keyword.toLowerCase()));
    if (blocked.length > 0) {
      return rejection(this.id, `contains excluded keyword(s): ${blocked.join(", ")}`);
    }

    if (includeKeywords.length > 0) {
      const found = includeKeywords.filter((keyword) => text.includes(keyword.toLowerCase()));
      if (found.length === 0) {
        return rejection(this.id, `matches none of the required keywords [${includeKeywords.join(", ")}]`);
      }
      return hardPass(this.id, `matches required keyword(s): ${found.join(", ")}`);
    }

    return hardPass(this.id, "no keyword filter configured");
  },
};

export const companyBlacklistRule: Rule = {
  id: "hard.company-blacklist",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    const blacklist = context.config.hard.companyBlacklist;
    if (blacklist.length === 0) return hardPass(this.id, "company blacklist is empty");
    const name = job.company.name.toLowerCase();
    const hit = blacklist.find((entry) => name.includes(entry.toLowerCase()));
    return hit === undefined
      ? hardPass(this.id, "company is not blacklisted")
      : rejection(this.id, `company matches blacklist entry "${hit}"`);
  },
};

export const outsourcingRule: Rule = {
  id: "hard.outsourcing",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    if (!context.config.hard.excludeOutsourcing) {
      return hardPass(this.id, "outsourcing exclusion disabled");
    }
    if (job.company.isOutsourcing === true) {
      return rejection(this.id, "posting is flagged as outsourcing / dispatch staffing");
    }
    // Textual fallback only fires on explicit phrases, never on the word "外包"
    // appearing inside unrelated prose.
    const text = jobText(job);
    const markers = ["人力资源外包", "外包公司", "劳务派遣", "人力外派"];
    const marker = markers.find((entry) => text.includes(entry));
    return marker === undefined
      ? hardPass(this.id, "no outsourcing marker detected")
      : rejection(this.id, `description contains outsourcing marker "${marker}"`);
  },
};

export const headhunterRule: Rule = {
  id: "hard.headhunter",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    if (!context.config.hard.excludeHeadhunter) {
      return hardPass(this.id, "headhunter exclusion disabled");
    }
    const headhunter = job.recruiters.find((recruiter) => recruiter.isHeadhunter === true);
    return headhunter === undefined
      ? hardPass(this.id, "no headhunter recruiter detected")
      : rejection(this.id, `listing is posted by a headhunter ("${headhunter.name}")`);
  },
};

export const alreadyProcessedRule: Rule = {
  id: "hard.already-processed",
  kind: "hard",
  evaluate(job: JobDetail, context: RuleContext): RuleResult {
    return context.processedJobIds.has(job.id)
      ? rejection(this.id, "job already exists in application history")
      : hardPass(this.id, "job is not in application history");
  },
};
