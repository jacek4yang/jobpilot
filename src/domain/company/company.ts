import { asCompanyId, type CompanyId } from "../support/ids";

export interface Company {
  readonly id: CompanyId;
  readonly name: string;
  /** Industry label as displayed by the platform, when present. */
  readonly industry?: string;
  /** Financing stage label, when present (e.g. "已上市"). */
  readonly stage?: string;
  readonly size?: string;
  /**
   * True when the posting advertises outsourcing / dispatch staffing
   * ("外包", "人力外派"). Drives the outsourcing blacklist rule.
   */
  readonly isOutsourcing?: boolean;
}

const normalizeCompanyName = (name: string): string =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

export const createCompany = (input: Omit<Company, "id"> & { id?: CompanyId }): Company => {
  const id = input.id ?? asCompanyId(normalizeCompanyName(input.name));
  const base = {
    id,
    name: input.name.trim(),
  };
  return {
    ...base,
    ...(input.industry === undefined ? {} : { industry: input.industry }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.isOutsourcing === undefined ? {} : { isOutsourcing: input.isOutsourcing }),
  };
};
