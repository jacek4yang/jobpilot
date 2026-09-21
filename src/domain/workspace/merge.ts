/**
 * Data ownership and three-way merge policy.
 *
 * Enforces strict separation between three field classes:
 * 1. Platform-derived (salary, company, description, location) -> may refresh from page.
 * 2. User-authored (notes, preference, tags, questions, pipeline) -> NEVER overwritten automatically.
 * 3. System-derived (match score, extracted benefits, concerns) -> may recalculate.
 */

import type { StoredJob } from "./types";

export interface MergeJobOptions {
  readonly now: number;
}

/**
 * Merges a newly visited or scanned job posting with an existing stored snapshot.
 *
 * Invariants:
 * - `firstSeenAt` is preserved from the existing snapshot if present.
 * - `lastSeenAt` is updated to the current timestamp.
 * - Missing or undefined fields in `incoming` do not erase known non-empty fields in `existing`.
 * - User-authored data lives in separate entities (`JobAnnotation`, `PipelineRecord`)
 *   so there is zero risk of platform page data trampling user notes or preferences.
 */
export const mergeJobSnapshot = (
  existing: StoredJob | undefined,
  incoming: Partial<StoredJob> & Pick<StoredJob, "id" | "platform" | "title" | "companyName">,
  options: MergeJobOptions,
): StoredJob => {
  const now = options.now;
  const firstSeenAt = existing?.firstSeenAt ?? incoming.firstSeenAt ?? now;

  return {
    id: incoming.id,
    platform: incoming.platform,
    title: incoming.title.trim() || existing?.title || "",
    companyName: incoming.companyName.trim() || existing?.companyName || "",

    salaryRaw: incoming.salaryRaw ?? existing?.salaryRaw,
    minSalaryK: incoming.minSalaryK ?? existing?.minSalaryK,
    maxSalaryK: incoming.maxSalaryK ?? existing?.maxSalaryK,

    locationRaw: incoming.locationRaw ?? existing?.locationRaw,
    city: incoming.city ?? existing?.city,
    district: incoming.district ?? existing?.district,

    experience: incoming.experience ?? existing?.experience,
    education: incoming.education ?? existing?.education,

    companyScale: incoming.companyScale ?? existing?.companyScale,
    industry: incoming.industry ?? existing?.industry,
    financingStage: incoming.financingStage ?? existing?.financingStage,

    recruiterName: incoming.recruiterName ?? existing?.recruiterName,
    recruiterRole: incoming.recruiterRole ?? existing?.recruiterRole,
    recruiterActivity: incoming.recruiterActivity ?? existing?.recruiterActivity,

    description: incoming.description ?? existing?.description,
    skills: incoming.skills ?? existing?.skills,
    requirements: incoming.requirements ?? existing?.requirements,

    benefits: incoming.benefits ?? existing?.benefits,
    potentialConcerns: incoming.potentialConcerns ?? existing?.potentialConcerns,

    canonicalUrl: incoming.canonicalUrl ?? existing?.canonicalUrl,
    sourceFingerprint: incoming.sourceFingerprint ?? existing?.sourceFingerprint,

    firstSeenAt,
    lastSeenAt: now,
  };
};
