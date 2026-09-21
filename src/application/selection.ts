/**
 * Operator selection filter for batch runs.
 *
 * The simplified product flow is 搜索 → 选择 → 批量投递. The execution pipeline
 * (orchestrator scan → evaluate → apply) stays untouched; instead the platform
 * scan result is filtered to the jobs the operator explicitly selected. An
 * empty selection means "no restriction" (legacy behaviour: the whole listing
 * is in scope), so the filter is a pure narrowing that can never widen scope.
 */

/**
 * Narrows scanned summaries to the selected job ids.
 *
 * Failure mode: returns the input unchanged when the selection is empty, and
 * drops a summary whose id is missing or unselected. Never throws.
 */
export const filterSummariesBySelection = <T extends { readonly id: unknown }>(
  summaries: readonly T[],
  selected: ReadonlySet<string>,
): readonly T[] => {
  if (selected.size === 0) return summaries;
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
