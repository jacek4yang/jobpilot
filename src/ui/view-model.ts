/**
 * View models for the JobPilot panel.
 */

import type { AutomationMode, JobPilotConfig, StoredSearchProfile } from "../config/schema";
import type {
  InterviewRecord,
  JobStage,
  PersonalPreference,
  QuestionItem,
} from "../domain/workspace/types";
import type { JobPilotBackupV1 } from "../storage/backup/backup-service";
import { t } from "./i18n";

export type PanelTab =
  | "home"
  | "jobs"
  | "pipeline"
  | "search"
  | "matches"
  | "queue"
  | "history"
  | "rules"
  | "messages"
  | "settings"
  | "diagnostics"
  | "logs";

/** Drives the header indicator. */
export type SafetyLevel = "safe" | "auto" | "paused" | "blocked";

export interface UiCallbacks {
  /** Runs discovery for the active search profile and populates Matches. */
  readonly discover: () => void;
  /** Toggles whether a discovered job is included in the next batch run. */
  readonly onToggleMatchSelect?: ((jobId: string) => void) | undefined;
  readonly start: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  /** Step one of human-verification recovery: validate the page, do not resume. */
  readonly recheck: () => void;
  readonly skipCurrent: () => void;
  readonly stop: () => void;
  readonly setCollapsed: (collapsed: boolean) => void;
  readonly onSaveLayout?:
    | ((geometry: {
        readonly width: number;
        readonly height: number;
        readonly x: number;
        readonly y: number;
        readonly collapsed: boolean;
      }) => void)
    | undefined;
  readonly onResetLayout?: (() => void) | undefined;
  readonly onSaveDisplayName?: ((name: string) => void) | undefined;

  // Personal Job Workspace callbacks
  readonly onSetPreference?: ((jobId: string, preference: PersonalPreference) => void) | undefined;
  readonly onSaveNote?: ((jobId: string, note: string) => void) | undefined;
  readonly onTogglePin?: ((jobId: string) => void) | undefined;
  readonly onToggleTag?:
    | ((
        jobId: string,
        category: "positive" | "concern" | "question" | "custom",
        tag: string,
      ) => void)
    | undefined;
  readonly onUpdateQuestions?:
    | ((jobId: string, questions: readonly QuestionItem[]) => void)
    | undefined;
  readonly onSetPipelineStage?:
    | ((jobId: string, stage: JobStage, note?: string) => void)
    | undefined;
  readonly onSaveInterview?: ((record: InterviewRecord) => void) | undefined;
  readonly onDeleteInterview?: ((id: string) => void) | undefined;
  readonly onExportBackup?: (() => void) | undefined;
  readonly onImportBackup?:
    | ((backup: JobPilotBackupV1, mode: "merge" | "replace") => Promise<void>)
    | undefined;
  readonly onPruneData?: (() => void) | undefined;
  readonly onClearAllData?: (() => void) | undefined;
  readonly onSelectTab?: ((tab: PanelTab) => void) | undefined;

  /**
   * Persists the search profile the Search page edits. Called on every field
   * change so typed values survive panel re-renders (the page rebuilds its DOM
   * from persisted state on each render) and page reloads.
   */
  readonly onSaveSearchProfile?: ((profile: StoredSearchProfile) => void) | undefined;
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

  readonly displayName?: string | undefined;
  readonly config?: JobPilotConfig | undefined;
  readonly channel?: string | undefined;

  readonly message?:
    | {
        readonly tone: "info" | "warn" | "error" | "success";
        readonly text: string;
      }
    | undefined;
  readonly blocked?: BlockedView | undefined;
  readonly current?: CurrentItemView | undefined;
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
  if (state === "blocked" || state === "failed") {
    return { level: "blocked", label: t("header.safetyBlocked") };
  }
  if (state === "paused") {
    return { level: "paused", label: t("header.safetyPaused") };
  }
  if (mode === "automatic") {
    return { level: "auto", label: t("header.safetyAuto") };
  }
  return { level: "safe", label: t("header.safetySafe") };
};
