/**
 * Operator selection filter for batch runs.
 *
 * The simplified product flow is 搜索 → 选择 → 批量投递. The execution pipeline
 * (orchestrator scan → evaluate → apply) stays untouched; instead the platform
 * scan result is filtered to the jobs the operator explicitly selected. An
 * empty selection selects nothing. This is fail-closed: deselecting every job
 * must never widen the batch back to the whole listing.
 */

/**
 * Narrows scanned summaries to the selected job ids.
 *
 * Failure mode: returns an empty array when the selection is empty, and drops a
 * summary whose id is missing or unselected. Never throws and never widens.
 */
export const filterSummariesBySelection = <T extends { readonly id: unknown }>(
  summaries: readonly T[],
  selected: ReadonlySet<string>,
): readonly T[] => {
  if (selected.size === 0) return [];
  return summaries.filter((summary) => selected.has(String(summary.id)));
};

/**
 * Whether a batch selection may narrow a scan on the CURRENT page.
 *
 * A selection is only meaningful on the listing it was made on: it is
 * recorded at discovery time together with the page URL. On any other page
 * the selection is stale, and filtering by it would silently empty an
 * otherwise valid scan (the live bug: "the page clearly has jobs but the run
 * says none found" after navigating to a new listing). Stale → no filter,
 * which matches the empty-selection legacy behaviour.
 */
export const isSelectionCurrent = (
  selectionHref: string | undefined,
  currentHref: string | undefined,
): boolean => selectionHref !== undefined && selectionHref === currentHref;

export interface SelectedJobIdentity {
  readonly id: string;
  readonly title: string;
  readonly companyName: string;
  readonly url?: string;
}

export type SelectionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "empty" | "stale-page" | "missing-job" | "identity-conflict";
      readonly jobId?: string;
    };

/** Validates the immutable discovery snapshot before a finite batch may run. */
export const validateSelectionSnapshot = (
  selected: ReadonlyMap<string, SelectedJobIdentity>,
  selectionHref: string | undefined,
  currentHref: string | undefined,
  scanned?: readonly SelectedJobIdentity[],
): SelectionValidation => {
  if (selected.size === 0) return { ok: false, reason: "empty" };
  if (!isSelectionCurrent(selectionHref, currentHref)) {
    return { ok: false, reason: "stale-page" };
  }
  if (scanned === undefined) return { ok: true };

  const currentById = new Map(scanned.map((job) => [job.id, job]));
  for (const [id, expected] of selected) {
    const current = currentById.get(id);
    if (current === undefined) return { ok: false, reason: "missing-job", jobId: id };
    if (
      current.title !== expected.title ||
      current.companyName !== expected.companyName ||
      (current.url !== undefined && expected.url !== undefined && current.url !== expected.url)
    ) {
      return { ok: false, reason: "identity-conflict", jobId: id };
    }
  }
  return { ok: true };
};
