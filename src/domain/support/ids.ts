/**
 * Branded identifier types.
 *
 * These are compile-time only brands: they prevent accidentally passing a
 * `CompanyId` where a `JobId` is expected. At runtime they are plain strings.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Stable identifier for a job posting. */
export type JobId = Brand<string, "JobId">;

/** Stable identifier for a company. */
export type CompanyId = Brand<string, "CompanyId">;

/** Stable identifier for a recruiter / hiring manager. */
export type RecruiterId = Brand<string, "RecruiterId">;

/** Stable identifier for an application record. */
export type ApplicationId = Brand<string, "ApplicationId">;

/** Identifier of a registered platform adapter, e.g. `boss`. */
export type PlatformId = Brand<string, "PlatformId">;

export const asJobId = (value: string): JobId => value as JobId;
export const asCompanyId = (value: string): CompanyId => value as CompanyId;
export const asRecruiterId = (value: string): RecruiterId => value as RecruiterId;
export const asApplicationId = (value: string): ApplicationId => value as ApplicationId;
export const asPlatformId = (value: string): PlatformId => value as PlatformId;
