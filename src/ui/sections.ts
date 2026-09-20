/**
 * Panel section renderers.
 *
 * Each function turns plain view-model data into a DOM subtree. They are
 * separated from the panel shell so that the shell owns chrome (tabs, launcher,
 * action bar) and these own content, and so each can be exercised in isolation.
 */
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
} from "./view-model";

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const section = (doc: Document, title: string): HTMLElement => {
  const wrapper = el(doc, "section", "jobpilot-section");
  wrapper.append(el(doc, "span", "jobpilot-section-title", title));
  return wrapper;
};

/** Message banner. Tone drives colour; text is never truncated. */
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

/**
 * Blocked state.
 *
 * The reason is the largest text on screen and the required user action is
 * spelled out, because a user who cannot tell why automation stopped will
 * either panic or re-enable it blindly.
 */
export const renderBlocked = (doc: Document, blocked: BlockedView): HTMLElement => {
  const wrapper = el(doc, "div", "jobpilot-blocked");
  wrapper.setAttribute("role", "alert");
  wrapper.append(
    el(doc, "p", "jobpilot-blocked-reason", blocked.reason),
    el(doc, "p", "jobpilot-blocked-body", blocked.body),
  );
  return wrapper;
};

/** The job currently being worked on, plus its phase. */
export const renderCurrent = (doc: Document, current: CurrentItemView): HTMLElement => {
  const wrapper = section(doc, "Current");
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

/**
 * Decisions the user must make before work continues.
 *
 * Rendered prominently and above everything else, because each one represents
 * either a message that may have been sent or user content that must be
 * protected.
 */
export const renderDecisions = (
  doc: Document,
  decisions: readonly PendingDecisionView[],
): HTMLElement => {
  const wrapper = section(doc, "Needs your attention");
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
  const wrapper = section(doc, "Progress");
  const grid = el(doc, "div", "jobpilot-stats");
  for (const tile of stats) {
    const box = el(doc, "div", "jobpilot-stat");
    box.append(
      el(doc, "span", "jobpilot-stat-label", tile.label),
      el(doc, "span", "jobpilot-stat-value", String(tile.value)),
    );
    grid.append(box);
  }
  wrapper.append(grid);
  return wrapper;
};

const scoreBand = (score: number, accepted: boolean): string => {
  if (!accepted) return "low";
  return score >= 80 ? "high" : "normal";
};

/** Match list with per-row reasons, so a score is never shown unexplained. */
export const renderMatches = (doc: Document, matches: readonly MatchRowView[]): HTMLElement => {
  const wrapper = section(doc, "Matches");
  if (matches.length === 0) {
    wrapper.append(
      el(
        doc,
        "p",
        "jobpilot-hint",
        "No matches yet. Run a search profile from the Search tab to discover jobs.",
      ),
    );
    return wrapper;
  }

  const list = el(doc, "ul", "jobpilot-list");
  for (const match of matches) {
    const row = el(doc, "li", "jobpilot-row");

    const check = el(doc, "input", "jobpilot-checkbox");
    check.type = "checkbox";
    check.checked = match.selected;
    check.disabled = true; // Selection is driven by the controller, not by raw clicks here.
    check.setAttribute("aria-label", `Select ${match.title}`);
    row.append(check);

    const score = el(doc, "span", "jobpilot-score", match.accepted ? String(match.score) : "—");
    score.setAttribute("data-band", scoreBand(match.score, match.accepted));
    row.append(score);

    const main = el(doc, "div", "jobpilot-row-main");
    main.append(
      el(doc, "div", "jobpilot-row-title", match.title),
      el(doc, "div", "jobpilot-row-meta", `${match.company} · ${match.meta}`),
    );

    if (match.reasons.length > 0) {
      const reasons = el(doc, "ul", "jobpilot-row-reasons");
      for (const reason of match.reasons) {
        const item = el(doc, "li", "jobpilot-reason", reason);
        if (reason.startsWith("+")) item.setAttribute("data-sign", "plus");
        else if (reason.startsWith("-")) item.setAttribute("data-sign", "minus");
        reasons.append(item);
      }
      main.append(reasons);
    }

    row.append(main);
    list.append(row);
  }

  wrapper.append(list);
  return wrapper;
};

export const renderQueue = (doc: Document, queue: readonly QueueRowView[]): HTMLElement => {
  const wrapper = section(doc, "Queue");
  if (queue.length === 0) {
    wrapper.append(el(doc, "p", "jobpilot-hint", "Queue is empty."));
    return wrapper;
  }

  const list = el(doc, "ul", "jobpilot-list");
  for (const item of queue) {
    const row = el(doc, "li", "jobpilot-row");
    const main = el(doc, "div", "jobpilot-row-main");

    const chip = el(doc, "span", "jobpilot-status-chip", item.status);
    chip.setAttribute("data-status", item.status);

    main.append(
      el(doc, "div", "jobpilot-row-title", item.title),
      el(doc, "div", "jobpilot-row-meta", `${item.company} · ${item.detail}`),
    );
    row.append(chip, main);
    list.append(row);
  }

  wrapper.append(list);
  return wrapper;
};

export const renderHistory = (doc: Document, rows: readonly HistoryRowView[]): HTMLElement => {
  const wrapper = section(doc, "History");
  if (rows.length === 0) {
    wrapper.append(el(doc, "p", "jobpilot-hint", "No jobs processed yet."));
    return wrapper;
  }

  const list = el(doc, "ul", "jobpilot-list");
  for (const row of rows) {
    const item = el(doc, "li", "jobpilot-row");
    const main = el(doc, "div", "jobpilot-row-main");
    const chip = el(doc, "span", "jobpilot-status-chip", row.outcome);
    chip.setAttribute("data-status", row.outcome);
    main.append(
      el(doc, "div", "jobpilot-row-title", row.title),
      el(doc, "div", "jobpilot-row-meta", `${row.company} · ${row.meta}`),
    );
    item.append(chip, main);
    list.append(item);
  }

  wrapper.append(list);
  return wrapper;
};

/** Human-readable activity feed. Technical detail lives behind a disclosure. */
export const renderLogs = (doc: Document, rows: readonly LogRowView[]): HTMLElement => {
  const wrapper = section(doc, "Activity");
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

  const disclosure = el(doc, "details", "jobpilot-disclosure");
  disclosure.append(el(doc, "summary", undefined, "Diagnostics"));
  const hint = el(
    doc,
    "p",
    "jobpilot-hint",
    "Technical entries are redacted: cookies, tokens, credentials and message content are never recorded.",
  );
  disclosure.append(hint);
  wrapper.append(disclosure);

  return wrapper;
};

/** Pre-rendered section map handed to the panel. */
export const buildSections = (
  doc: Document,
  input: {
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
  },
): Partial<Record<PanelTab, HTMLElement>> => {
  const overview = doc.createElement("div");
  if (input.blocked !== undefined) {
    overview.append(renderBlocked(doc, input.blocked));
  } else if (input.message !== undefined) {
    overview.append(renderMessage(doc, input.message.tone, input.message.text));
  }
  if (input.decisions.length > 0) overview.append(renderDecisions(doc, input.decisions));
  if (input.current !== undefined) overview.append(renderCurrent(doc, input.current));
  overview.append(renderStats(doc, input.stats));

  return {
    search: overview,
    matches: renderMatches(doc, input.matches),
    queue: renderQueue(doc, input.queue),
    history: renderHistory(doc, input.history),
    rules: renderRulesPlaceholder(doc),
    messages: renderMessagesPlaceholder(doc),
    settings: renderSettingsPlaceholder(doc),
    logs: renderLogs(doc, input.logs),
  };
};

const renderRulesPlaceholder = (doc: Document): HTMLElement => {
  const wrapper = section(doc, "Rules");
  wrapper.append(
    el(
      doc,
      "p",
      "jobpilot-hint",
      "Hard filters reject a job outright; soft weights rank the survivors. Every decision is recorded with its reasons on the Matches tab.",
    ),
  );
  return wrapper;
};

const renderMessagesPlaceholder = (doc: Document): HTMLElement => {
  const wrapper = section(doc, "Messages");
  wrapper.append(
    el(
      doc,
      "p",
      "jobpilot-hint",
      "Templates support {{jobTitle}}, {{company}} and {{recruiter}}. A template that cannot resolve a variable is refused rather than sent incomplete.",
    ),
  );
  return wrapper;
};

const renderSettingsPlaceholder = (doc: Document): HTMLElement => {
  const wrapper = section(doc, "Settings");
  wrapper.append(
    el(
      doc,
      "p",
      "jobpilot-hint",
      "Timeouts and selector tuning live under Advanced and rarely need changing.",
    ),
  );
  return wrapper;
};
