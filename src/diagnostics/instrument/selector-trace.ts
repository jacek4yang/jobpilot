/**
 * Selector instrumentation.
 *
 * Records which selector candidate matched, which missed, and which was
 * ambiguous — per semantic purpose. This is the single most valuable artefact
 * when BOSS changes its markup: it says exactly which candidate stopped working
 * and what the alternatives did, without anyone needing to reproduce the page.
 *
 * It is deliberately a *reporter*, not a resolver. It observes an attempt the
 * caller has already made; it never selects an element itself, so instrumenting
 * the registry cannot change which candidate wins.
 */
import type { JsonValue } from "../event";
import { EVENTS } from "../event";
import type { DiagnosticRecorder } from "../recorder";

/** One candidate's outcome within a single resolve attempt. */
export interface SelectorAttempt {
  readonly selector: string;
  readonly confidence: string;
  /** Total matches for this candidate. */
  readonly matches: number;
  /** Matches that were visible. */
  readonly visible: number;
  /** Whether this candidate was the one selected. */
  readonly selected: boolean;
  /** Why it was rejected, when it was. */
  readonly rejectedBecause?: "no-match" | "ambiguous" | "hidden" | "context";
}

export interface SelectorOutcome {
  /** Semantic purpose, e.g. `detail.applyButton`. */
  readonly purpose: string;
  readonly attempts: readonly SelectorAttempt[];
  /** The winner, or undefined when nothing resolved. */
  readonly selected?: string;
  /** True when the winning candidate was a heuristic rather than an anchor. */
  readonly heuristic: boolean;
}

const summarise = (outcome: SelectorOutcome): string => {
  if (outcome.selected !== undefined) return `matched via ${outcome.selected}`;
  const anyMatch = outcome.attempts.some((attempt) => attempt.matches > 0);
  return anyMatch ? "candidates matched but none was usable" : "no candidate matched";
};

/**
 * Records a selector resolution.
 *
 * Emits exactly one of `selector.match`, `selector.miss` or
 * `selector.ambiguous` so the analyzer can count failures per purpose without
 * parsing candidate-level detail, and attaches the full candidate list so a
 * maintainer can see which alternates remain available.
 */
export const recordSelectorOutcome = (
  recorder: DiagnosticRecorder,
  outcome: SelectorOutcome,
): void => {
  const ambiguous = outcome.attempts.some((attempt) => attempt.rejectedBecause === "ambiguous");

  const event =
    outcome.selected !== undefined
      ? EVENTS.selectorMatch
      : ambiguous
        ? EVENTS.selectorAmbiguous
        : EVENTS.selectorMiss;

  const level = outcome.selected !== undefined ? "trace" : ambiguous ? "warn" : "warn";

  recorder.record({
    level,
    category: "selector",
    event,
    data: {
      purpose: outcome.purpose,
      selected: outcome.selected ?? null,
      heuristic: outcome.heuristic,
      summary: summarise(outcome),
      candidates: outcome.attempts.map(
        (attempt): JsonValue => ({
          selector: attempt.selector,
          confidence: attempt.confidence,
          matches: attempt.matches,
          visible: attempt.visible,
          selected: attempt.selected,
          ...(attempt.rejectedBecause === undefined
            ? {}
            : { rejectedBecause: attempt.rejectedBecause }),
        }),
      ),
    } satisfies Record<string, JsonValue>,
  });
};

/**
 * Builds an outcome from a set of attempts.
 *
 * Small helper so every call site reports the same shape, and so the
 * "ambiguous beats miss" rule — an ambiguity is a worse failure than an absence,
 * because it means the page has more candidates than expected — is applied
 * consistently rather than re-derived per site.
 */
export const describeResolution = (
  purpose: string,
  attempts: readonly SelectorAttempt[],
): SelectorOutcome => {
  const winner = attempts.find((attempt) => attempt.selected);
  return {
    purpose,
    attempts,
    ...(winner === undefined ? {} : { selected: winner.selector }),
    // A heuristic winner means the semantic anchors failed and a fallback was
    // used, which is worth surfacing even on a successful match.
    heuristic: winner?.confidence === "unverified",
  };
};
