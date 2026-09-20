/**
 * View models for the panel.
 *
 * A view model is plain data: the controller assembles it from application
 * state, and the panel renders it. Keeping this boundary explicit means the
 * panel can be tested by feeding it a literal object, and the controller can be
 * tested without a DOM.
 */
import type { AutomationMode } from "../config/schema";

export type PanelTab =
  | "search"
  | "matches"
  | "queue"
  | "history"
  | "rules"
  | "messages"
  | "settings"
  | "logs";

/** Drives the header indicator. */
export type SafetyLevel = "safe" | "auto" | "paused" | "blocked";

export interface UiCallbacks {
  /** Runs discovery for the active search profile and populates Matches. */
  readonly discover: () => void;
  readonly start: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  /** Step one of human-verification recovery: validate the page, do not resume. */
  readonly recheck: () => void;
  readonly skipCurrent: () => void;
  readonly stop: () => void;
  readonly setCollapsed: (collapsed: boolean) => void;
}

export interface StatTile {
  readonly label: string;
  readonly value: number;
}

export interface MatchRowView {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly meta: string;
  readonly score: number;
  readonly accepted: boolean;
  readonly selected: boolean;
  /** Ordered rule trace, already formatted for display. */
  readonly reasons: readonly string[];
}

export interface QueueRowView {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly status: string;
  readonly detail: string;
}

export interface HistoryRowView {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly outcome: string;
  readonly meta: string;
}

export interface LogRowView {
  readonly level: string;
  readonly time: string;
  readonly component: string;
  readonly message: string;
}

export interface CurrentItemView {
  readonly title: string;
  readonly company: string;
  readonly score?: number;
  readonly phase: string;
}

export interface BlockedView {
  readonly reason: string;
  readonly body: string;
  readonly canResume: boolean;
}

/** A pending decision the user must resolve before work can continue. */
export interface PendingDecisionView {
  readonly kind: "uncertain-send" | "draft-present" | "mode-conflict";
  readonly jobId: string;
  readonly title: string;
  readonly message: string;
  readonly actions: readonly { readonly id: string; readonly label: string }[];
}

/**
 * A rendered panel section.
 *
 * Sections are DOM nodes built by the controller's renderers. Keeping nodes
 * here (rather than a declarative tree) avoids inventing a diffing layer for a
 * panel this small.
 */
export interface PanelViewModel {
  readonly state: string;
  readonly mode: AutomationMode;
  readonly safety: SafetyLevel;
  readonly safetyLabel: string;
  readonly launcherCount: string;
  /** The page classification the adapter currently reports, e.g. "job-list". */
  readonly pageKind: string;

  readonly running: boolean;
  readonly paused: boolean;

  readonly message?: {
    readonly tone: "info" | "warn" | "error" | "success";
    readonly text: string;
  };
  readonly blocked?: BlockedView;
  readonly current?: CurrentItemView;
  readonly decisions: readonly PendingDecisionView[];

  readonly stats: readonly StatTile[];
  readonly matches: readonly MatchRowView[];
  readonly queue: readonly QueueRowView[];
  readonly history: readonly HistoryRowView[];
  readonly logs: readonly LogRowView[];

  /** Pre-rendered section DOM, keyed by tab. */
  readonly sections: Partial<Record<PanelTab, HTMLElement>>;
}

/** Maps the automation state to the header safety indicator. */
export const safetyFromState = (
  state: string,
  mode: AutomationMode,
): { readonly level: SafetyLevel; readonly label: string } => {
  if (state === "blocked" || state === "failed") return { level: "blocked", label: "Blocked" };
  if (state === "paused") return { level: "paused", label: "Paused" };
  if (mode === "automatic") return { level: "auto", label: "Auto" };
  return { level: "safe", label: "Safe" };
};
