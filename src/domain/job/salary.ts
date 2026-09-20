/**
 * Salary parsing.
 *
 * BOSS salary strings look like `15-25K·14薪`, `200-300元/天`, `面议`.
 * Parsing is deliberately conservative: when a string cannot be parsed
 * confidently we return a range with `unknown` bounds rather than guessing,
 * and rules treat unknown salary as "do not hard-reject".
 */

export type SalaryPeriod = "month" | "day" | "year" | "unknown";

export interface SalaryRange {
  readonly min?: number;
  readonly max?: number;
  /** Unit of the `min`/`max` numbers. */
  readonly period: SalaryPeriod;
  /** Number of months per year when advertised, e.g. 14 in `15-25K·14薪`. */
  readonly monthsPerYear?: number;
  /** Original text, always preserved for explainability. */
  readonly raw: string;
  readonly parsed: boolean;
}

const RANGE_RE = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(K|k|千|万|元)?/;
const SINGLE_RE = /(\d+(?:\.\d+)?)\s*(K|k|千|万)\b/;
const MONTHS_RE = /(\d{1,2})\s*薪/;

const PERIOD_UNIT: Record<string, SalaryPeriod> = {
  "/天": "day",
  "元/天": "day",
  "每天": "day",
  "/年": "year",
  "元/年": "year",
};

const detectPeriod = (text: string): SalaryPeriod => {
  for (const [needle, period] of Object.entries(PERIOD_UNIT)) {
    if (text.includes(needle)) return period;
  }
  if (text.includes("天")) return "day";
  if (text.includes("年")) return "year";
  return "month";
};

/** Scales a `万`-denominated value into the monthly-k RMB baseline used by rules. */
const toMonthlyK = (value: number, unit: string | undefined, period: SalaryPeriod): number => {
  if (period === "day") return value * 21.75 * (unit === "元" || unit === undefined ? 0.001 : 1);
  if (period === "year") return (value * (unit === "万" ? 10 : 0.001)) / 12;
  if (unit === "万") return value * 10;
  if (unit === "元") return value * 0.001;
  return value;
};

export const parseSalary = (raw: string | undefined | null): SalaryRange => {
  const text = (raw ?? "").trim();
  if (text.length === 0 || /面议|保密|薪资面议/.test(text)) {
    return { period: "unknown", raw: text, parsed: false };
  }

  const period = detectPeriod(text);
  const monthsMatch = MONTHS_RE.exec(text);
  const monthsPerYear = monthsMatch?.[1] ? Number.parseInt(monthsMatch[1], 10) : undefined;
  const base = {
    period,
    raw: text,
    ...(monthsPerYear === undefined ? {} : { monthsPerYear }),
  };

  const range = RANGE_RE.exec(text);
  if (range?.[1] && range[2]) {
    const min = toMonthlyK(Number.parseFloat(range[1]), range[3], period);
    const max = toMonthlyK(Number.parseFloat(range[2]), range[3], period);
    return { ...base, min: Math.min(min, max), max: Math.max(min, max), parsed: true };
  }

  const single = SINGLE_RE.exec(text);
  if (single?.[1]) {
    const value = toMonthlyK(Number.parseFloat(single[1]), single[2], period);
    return { ...base, min: value, max: value, parsed: true };
  }

  return { ...base, parsed: false };
};

/** Human-readable rendering used in rule explanations. */
export const formatSalary = (range: SalaryRange): string => {
  if (!range.parsed || range.min === undefined || range.max === undefined) {
    return range.raw.length > 0 ? range.raw : "unknown";
  }
  const unit = range.period === "day" ? "K/day" : range.period === "year" ? "K/year" : "K/month";
  return `${range.min}-${range.max}${unit}`;
};
