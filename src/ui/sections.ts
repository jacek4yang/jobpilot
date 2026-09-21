/**
 * Panel section builders and renderers.
 *
 * Connects the view models to the specialized page renderers while maintaining
 * full backward compatibility with bootstrap and existing test suites.
 */

import type { JobPilotConfig } from "../config/schema";
import type {
  CustomTag,
  InterviewRecord,
  JobAnnotation,
  PipelineRecord,
  StoredJob,
} from "../domain/workspace/types";
import { el } from "./components/chips";
import { renderHistoryPage } from "./pages/history";
import { renderHomePage } from "./pages/home";
import { renderJobsWorkspacePage } from "./pages/jobs-workspace";
import { renderMatchesPage } from "./pages/matches";
import { renderMessagesPage } from "./pages/messages";
import { renderPipelinePage } from "./pages/pipeline";
import { renderQueuePage } from "./pages/queue";
import { renderRulesPage } from "./pages/rules";
import { renderSearchPage } from "./pages/search";
import { renderSettingsPage } from "./pages/settings";
import type {
  BlockedView,
  CurrentItemView,
  HistoryRowView,
  LogRowView,
  MatchRowView,
  PanelTab,
  PendingDecisionView,
  QueueRowView,
  StatTile,
  UiCallbacks,
} from "./view-model";

const defaultCallbacks: UiCallbacks = {
  discover: () => {},
  start: () => {},
  pause: () => {},
  resume: () => {},
  recheck: () => {},
  skipCurrent: () => {},
  stop: () => {},
  setCollapsed: () => {},
};

export const renderMessage = (
  doc: Document,
  tone: "info" | "warn" | "error" | "success",
  text: string,
): HTMLElement => {
  const node = el(doc, "p", "jobpilot-message", text);
  node.setAttribute("data-tone", tone);
  node.setAttribute("role", tone === "error" ? "alert" : "status");
  return node;
};

export const renderBlocked = (doc: Document, blocked: BlockedView): HTMLElement => {
  const wrapper = el(doc, "div", "jobpilot-blocked");
  wrapper.setAttribute("role", "alert");
  wrapper.append(
    el(doc, "p", "jobpilot-blocked-reason", blocked.reason),
    el(doc, "p", "jobpilot-blocked-body", blocked.body),
  );
  return wrapper;
};

export const renderCurrent = (doc: Document, current: CurrentItemView): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", "Current"));
  const box = el(doc, "div", "jobpilot-current");
  box.append(
    el(doc, "div", "jobpilot-current-title", current.title),
    el(
      doc,
      "div",
      "jobpilot-current-meta",
      current.score === undefined ? current.company : `${current.company} · score ${current.score}`,
    ),
    el(doc, "div", "jobpilot-phase", current.phase),
  );
  wrapper.append(box);
  return wrapper;
};

export const renderDecisions = (
  doc: Document,
  decisions: readonly PendingDecisionView[],
): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", "Needs your attention"));
  const list = el(doc, "ul", "jobpilot-list");

  for (const decision of decisions) {
    const row = el(doc, "li", "jobpilot-row");
    const main = el(doc, "div", "jobpilot-row-main");
    main.append(
      el(doc, "div", "jobpilot-row-title", decision.title),
      el(doc, "div", "jobpilot-row-meta", decision.message),
    );
    const chip = el(doc, "span", "jobpilot-status-chip", "action required");
    chip.setAttribute("data-status", "uncertain");
    main.append(chip);
    row.append(main);
    list.append(row);
  }

  wrapper.append(list);
  return wrapper;
};

export const renderStats = (doc: Document, stats: readonly StatTile[]): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", "Progress"));
  const grid = el(doc, "div", "jobpilot-stats-grid");
  for (const tile of stats) {
    const box = el(doc, "div", "jobpilot-stat-card");
    box.append(
      el(doc, "span", "jobpilot-stat-label", tile.label),
      el(doc, "span", "jobpilot-stat-value", String(tile.value)),
    );
    grid.append(box);
  }
  wrapper.append(grid);
  return wrapper;
};

export const renderMatches = (doc: Document, matches: readonly MatchRowView[]): HTMLElement =>
  renderMatchesPage(doc, { matches, callbacks: defaultCallbacks });

export const renderQueue = (doc: Document, queue: readonly QueueRowView[]): HTMLElement =>
  renderQueuePage(doc, { queue, running: false, paused: false, callbacks: defaultCallbacks });

export const renderHistory = (doc: Document, rows: readonly HistoryRowView[]): HTMLElement =>
  renderHistoryPage(doc, { history: rows });

export const renderLogs = (doc: Document, rows: readonly LogRowView[]): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", "Activity"));
  const list = el(doc, "ul", "jobpilot-log");

  for (const row of rows) {
    const item = el(doc, "li", "jobpilot-log-item");
    item.setAttribute("data-level", row.level);
    item.append(
      el(doc, "span", "jobpilot-log-level", row.level),
      el(doc, "span", undefined, `${row.time} ${row.component}: ${row.message}`),
    );
    list.append(item);
  }

  wrapper.append(list);
  return wrapper;
};

export interface BuildSectionsInput {
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
  readonly config?: JobPilotConfig | undefined;
  readonly displayName?: string | undefined;
  readonly callbacks?: UiCallbacks | undefined;
  readonly state?: string | undefined;
  readonly running?: boolean | undefined;
  readonly paused?: boolean | undefined;
  readonly channel?: string | undefined;

  // Personal Job Workspace integration
  readonly currentJob?: StoredJob | undefined;
  readonly currentAnnotation?: JobAnnotation | undefined;
  readonly allJobs?: readonly StoredJob[] | undefined;
  readonly allAnnotations?: readonly JobAnnotation[] | undefined;
  readonly pipelineRecords?: readonly PipelineRecord[] | undefined;
  readonly interviews?: readonly InterviewRecord[] | undefined;
  readonly customTags?: readonly CustomTag[] | undefined;
  readonly storageStats?:
    | {
        readonly jobCount: number;
        readonly favoriteCount: number;
        readonly noteCount: number;
      }
    | undefined;
  readonly isLoggedIn?: boolean | undefined;
  readonly pageKind?: string | undefined;
  readonly favoriteCount?: number | undefined;
  readonly queueCount?: number | undefined;
  readonly pipelineCount?: number | undefined;
}

export const buildSections = (
  doc: Document,
  input: BuildSectionsInput,
): Partial<Record<PanelTab, HTMLElement>> => {
  const callbacks = input.callbacks ?? defaultCallbacks;

  const homePage = renderHomePage(doc, {
    displayName: input.displayName ?? input.config?.general?.displayName,
    state: input.state ?? "idle",
    running: input.running ?? false,
    paused: input.paused ?? false,
    message: input.message,
    blocked: input.blocked,
    current: input.current,
    decisions: input.decisions,
    stats: input.stats,
    callbacks,
    isDiagnostic: input.channel === "diagnostic",
    pageKind: input.pageKind,
    isLoggedIn: input.isLoggedIn,
    favoriteCount: input.favoriteCount,
    queueCount: input.queueCount,
    pipelineCount: input.pipelineCount,
    currentJob: input.currentJob,
    currentAnnotation: input.currentAnnotation,
  });

  const jobsPage = renderJobsWorkspacePage(doc, {
    currentJob: input.currentJob,
    currentAnnotation: input.currentAnnotation,
    allJobs: input.allJobs ?? [],
    allAnnotations: input.allAnnotations ?? [],
    customTags: input.customTags ?? [],
    callbacks,
  });

  const pipelinePage = renderPipelinePage(doc, {
    jobs: input.allJobs ?? [],
    pipelineRecords: input.pipelineRecords ?? [],
    interviews: input.interviews ?? [],
    callbacks,
  });

  const searchPage = renderSearchPage(doc, {
    config: input.config,
    callbacks,
  });

  const matchesPage = renderMatchesPage(doc, {
    matches: input.matches,
    callbacks,
  });

  const queuePage = renderQueuePage(doc, {
    queue: input.queue,
    running: input.running ?? false,
    paused: input.paused ?? false,
    callbacks,
  });

  const historyPage = renderHistoryPage(doc, {
    history: input.history,
  });

  const rulesPage = renderRulesPage(doc);
  const messagesPage = renderMessagesPage(doc);

  const settingsPage = renderSettingsPage(doc, {
    config: input.config,
    callbacks,
    storageStats: input.storageStats,
    onSaveDisplayName: (name) => {
      callbacks.onSaveDisplayName?.(name);
    },
    onResetLayout: () => {
      callbacks.onResetLayout?.();
    },
  });

  return {
    home: homePage,
    jobs: jobsPage,
    pipeline: pipelinePage,
    search: searchPage,
    matches: matchesPage,
    queue: queuePage,
    history: historyPage,
    rules: rulesPage,
    messages: messagesPage,
    settings: settingsPage,
    logs: renderLogs(doc, input.logs),
  };
};
