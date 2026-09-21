/**
 * Calm Home Dashboard page.
 *
 * Provides a gentle, reassuring overview:
 * - Localized personal greeting (without countdown or pressure)
 * - Login guidance prompt when not logged in
 * - Blocked / human verification banner when applicable
 * - Pending decisions
 * - "Today's low-pressure guidance" cards (Favorites, Queue, Pipeline)
 * - Current viewing job companion preview
 * - Clean progress indicators
 */

import type { JobAnnotation, StoredJob } from "../../domain/workspace/types";
import { el } from "../components/chips";
import { getGreeting, t } from "../i18n";
import type {
  BlockedView,
  CurrentItemView,
  PendingDecisionView,
  StatTile,
  UiCallbacks,
} from "../view-model";

export interface HomePageInput {
  readonly displayName?: string | undefined;
  readonly state: string;
  readonly running: boolean;
  readonly paused: boolean;
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
  readonly callbacks: UiCallbacks;
  readonly isDiagnostic?: boolean | undefined;

  // Workspace integration
  readonly pageKind?: string | undefined;
  readonly isLoggedIn?: boolean | undefined;
  readonly favoriteCount?: number | undefined;
  readonly queueCount?: number | undefined;
  readonly pipelineCount?: number | undefined;
  readonly currentJob?: StoredJob | undefined;
  readonly currentAnnotation?: JobAnnotation | undefined;
}

export const renderHomePage = (doc: Document, input: HomePageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-home");

  // --- 1. Gentle Personalized Greeting ------------------------------------
  const greetingCard = el(doc, "div", "jobpilot-greeting-card");
  const greetingText = el(doc, "p", "jobpilot-greeting-text", getGreeting(input.displayName));
  const greetingSub = el(doc, "p", "jobpilot-greeting-sub", t("search.subtitle"));
  greetingCard.append(greetingText, greetingSub);
  container.append(greetingCard);

  // --- 2. Login Guidance Prompt (Calm & Non-intrusive) ---------------------
  const isLoginRequired =
    input.isLoggedIn === false ||
    input.pageKind === "login-required" ||
    input.pageKind === "public-home";

  if (isLoginRequired) {
    const loginCard = el(doc, "div", "jobpilot-login-card");
    loginCard.setAttribute("role", "region");
    loginCard.setAttribute("aria-label", t("login.title"));

    const loginHeader = el(doc, "div", "jobpilot-login-header");
    const loginIcon = el(doc, "span", "jobpilot-login-icon", "👋");
    const loginTitle = el(doc, "h3", "jobpilot-login-title", t("login.title"));
    loginHeader.append(loginIcon, loginTitle);

    const loginDesc = el(doc, "p", "jobpilot-login-desc", t("login.desc"));

    const loginActionRow = el(doc, "div", "jobpilot-login-actions");
    const confirmBtn = el(doc, "button", "jobpilot-btn", t("login.confirmBtn"));
    confirmBtn.type = "button";
    confirmBtn.setAttribute("data-action", "login-confirm");
    confirmBtn.setAttribute("data-variant", "primary");
    confirmBtn.addEventListener("click", () => {
      input.callbacks.recheck();
    });
    loginActionRow.append(confirmBtn);

    loginCard.append(loginHeader, loginDesc, loginActionRow);
    container.append(loginCard);
  }

  // --- 3. Blocked / Human Verification Card -------------------------------
  if (input.blocked !== undefined) {
    const isVerification =
      input.blocked.reason.includes("verification") ||
      input.blocked.reason.includes("challenge") ||
      input.blocked.reason.includes("验证");

    const blockedCard = el(doc, "div", "jobpilot-blocked-card");
    blockedCard.setAttribute("role", "alert");

    const title = el(
      doc,
      "h3",
      "jobpilot-blocked-title",
      isVerification ? t("blocked.verificationTitle") : input.blocked.reason,
    );

    const body = el(
      doc,
      "div",
      "jobpilot-blocked-body",
      isVerification ? t("blocked.verificationBody") : input.blocked.body,
    );

    const actionRow = el(doc, "div", "jobpilot-blocked-actions");

    const recheckBtn = el(doc, "button", "jobpilot-btn", t("blocked.recheckButton"));
    recheckBtn.type = "button";
    recheckBtn.setAttribute("data-action", "recheck");
    recheckBtn.setAttribute("data-variant", "primary");
    recheckBtn.addEventListener("click", () => input.callbacks.recheck());
    actionRow.append(recheckBtn);

    const stopBtn = el(doc, "button", "jobpilot-btn", t("blocked.stopButton"));
    stopBtn.type = "button";
    stopBtn.setAttribute("data-variant", "danger");
    stopBtn.addEventListener("click", () => input.callbacks.stop());
    actionRow.append(stopBtn);

    blockedCard.append(title, body, actionRow);
    container.append(blockedCard);
  } else if (input.message !== undefined) {
    // Message banner
    const msg = el(doc, "div", "jobpilot-card");
    msg.style.borderLeft = `4px solid ${
      input.message.tone === "error"
        ? "var(--jp-danger)"
        : input.message.tone === "warn"
          ? "var(--jp-warning)"
          : input.message.tone === "success"
            ? "var(--jp-success)"
            : "var(--jp-primary)"
    }`;
    const text = el(doc, "p", undefined, input.message.text);
    text.style.margin = "0";
    msg.append(text);
    container.append(msg);
  }

  // --- 4. Decisions Card (e.g. uncertain send, draft detected) ------------
  if (input.decisions.length > 0) {
    const decisionWrapper = el(doc, "div", "jobpilot-section");
    decisionWrapper.append(el(doc, "span", "jobpilot-section-title", t("decisions.title")));

    for (const dec of input.decisions) {
      const card = el(doc, "div", "jobpilot-decision-card");
      const decTitle = el(doc, "div", "jobpilot-decision-title", dec.title);
      const decMsg = el(doc, "div", "jobpilot-decision-message", dec.message);
      const decActions = el(doc, "div", "jobpilot-decision-actions");

      for (const act of dec.actions) {
        const btn = el(doc, "button", "jobpilot-btn", act.label);
        btn.type = "button";
        if (act.id === "skip") btn.setAttribute("data-variant", "subtle");
        btn.addEventListener("click", () => {
          // Action resolution
        });
        decActions.append(btn);
      }

      card.append(decTitle, decMsg, decActions);
      decisionWrapper.append(card);
    }
    container.append(decisionWrapper);
  }

  // --- 5. Today's Guidance Cards (Gentle entry points) --------------------
  const guideWrapper = el(doc, "div", "jobpilot-section");
  guideWrapper.append(el(doc, "span", "jobpilot-section-title", "今天可以做什么"));

  const guideGrid = el(doc, "div", "jobpilot-guidance-grid");

  // Card A: 喜欢的职位
  const favCount = input.favoriteCount ?? 0;
  const favCard = el(doc, "div", "jobpilot-guidance-card");
  favCard.setAttribute("data-action", "goto-favorites");
  const favIcon = el(doc, "span", "jobpilot-guidance-icon", "💗");
  const favContent = el(doc, "div", "jobpilot-guidance-content");
  const favTitle = el(doc, "div", "jobpilot-guidance-title", "喜欢的职位");
  const favMeta = el(
    doc,
    "div",
    "jobpilot-guidance-meta",
    favCount > 0 ? `${favCount} 个已收藏` : "挑选心仪职位",
  );
  favContent.append(favTitle, favMeta);
  favCard.append(favIcon, favContent);
  favCard.addEventListener("click", () => {
    input.callbacks.onSelectTab?.("jobs");
  });
  guideGrid.append(favCard);

  // Card B: 待沟通队列
  const queueCount = input.queueCount ?? 0;
  const queueCard = el(doc, "div", "jobpilot-guidance-card");
  queueCard.setAttribute("data-action", "goto-queue");
  const queueIcon = el(doc, "span", "jobpilot-guidance-icon", "💬");
  const queueContent = el(doc, "div", "jobpilot-guidance-content");
  const queueTitle = el(doc, "div", "jobpilot-guidance-title", "待沟通队列");
  const queueMeta = el(
    doc,
    "div",
    "jobpilot-guidance-meta",
    queueCount > 0 ? `${queueCount} 个待处理` : "准备开始沟通",
  );
  queueContent.append(queueTitle, queueMeta);
  queueCard.append(queueIcon, queueContent);
  queueCard.addEventListener("click", () => {
    input.callbacks.onSelectTab?.("queue");
  });
  guideGrid.append(queueCard);

  // Card C: 求职进展
  const pipelineCount = input.pipelineCount ?? 0;
  const pipelineCard = el(doc, "div", "jobpilot-guidance-card");
  pipelineCard.setAttribute("data-action", "goto-pipeline");
  const pipelineIcon = el(doc, "span", "jobpilot-guidance-icon", "📩");
  const pipelineContent = el(doc, "div", "jobpilot-guidance-content");
  const pipelineTitle = el(doc, "div", "jobpilot-guidance-title", "求职进展");
  const pipelineMeta = el(
    doc,
    "div",
    "jobpilot-guidance-meta",
    pipelineCount > 0 ? `${pipelineCount} 个推进中` : "跟进面试与回复",
  );
  pipelineContent.append(pipelineTitle, pipelineMeta);
  pipelineCard.append(pipelineIcon, pipelineContent);
  pipelineCard.addEventListener("click", () => {
    input.callbacks.onSelectTab?.("pipeline");
  });
  guideGrid.append(pipelineCard);

  guideWrapper.append(guideGrid);
  container.append(guideWrapper);

  // --- 6. Current Activity or Current Job Companion -----------------------
  const currentWrapper = el(doc, "div", "jobpilot-section");
  currentWrapper.append(el(doc, "span", "jobpilot-section-title", t("home.currentActionTitle")));

  if (input.currentJob !== undefined) {
    // Show current job preview card
    const cJob = input.currentJob;
    const curCard = el(doc, "div", "jobpilot-current-card");
    curCard.setAttribute("data-current-job-id", cJob.id);

    const phase = el(doc, "div", "jobpilot-current-phase", `👀 正在浏览的职位`);

    const titleRow = el(doc, "div", "jobpilot-current-title", cJob.title);
    const metaParts = [cJob.companyName, cJob.salaryRaw, cJob.city].filter(Boolean);
    const metaRow = el(doc, "div", "jobpilot-current-meta", metaParts.join(" · "));

    // Quick preference buttons
    const prefRow = el(doc, "div", "jobpilot-pref-actions");
    prefRow.style.marginTop = "8px";
    prefRow.style.gap = "6px";

    const currentPref = input.currentAnnotation?.preference ?? "unset";

    const favBtn = el(
      doc,
      "button",
      "jobpilot-btn",
      currentPref === "favorite" ? "💗 已喜欢" : "💗 喜欢",
    );
    favBtn.type = "button";
    favBtn.setAttribute("data-action", "quick-pref-favorite");
    if (currentPref === "favorite") favBtn.setAttribute("data-variant", "primary");
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.callbacks.onSetPreference?.(cJob.id, currentPref === "favorite" ? "unset" : "favorite");
    });

    const maybeBtn = el(
      doc,
      "button",
      "jobpilot-btn",
      currentPref === "maybe" ? "☆ 已放再看看" : "☆ 再看看",
    );
    maybeBtn.type = "button";
    maybeBtn.setAttribute("data-action", "quick-pref-maybe");
    maybeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.callbacks.onSetPreference?.(cJob.id, currentPref === "maybe" ? "unset" : "maybe");
    });

    const openWorkspaceBtn = el(doc, "button", "jobpilot-btn", "记笔记与详情 →");
    openWorkspaceBtn.type = "button";
    openWorkspaceBtn.setAttribute("data-variant", "subtle");
    openWorkspaceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.callbacks.onSelectTab?.("jobs");
    });

    prefRow.append(favBtn, maybeBtn, openWorkspaceBtn);

    curCard.append(phase, titleRow, metaRow, prefRow);
    currentWrapper.append(curCard);
  } else if (input.current !== undefined) {
    const currentCard = el(doc, "div", "jobpilot-current-card");
    const phase = el(
      doc,
      "div",
      "jobpilot-current-phase",
      `${t("home.currentPhase")}: ${input.current.phase}`,
    );
    const jobTitle = el(doc, "div", "jobpilot-current-title", input.current.title);
    const jobMeta = el(
      doc,
      "div",
      "jobpilot-current-meta",
      input.current.score === undefined
        ? input.current.company
        : `${input.current.company} · ${t("matches.scoreBadge", { score: input.current.score })}`,
    );
    currentCard.append(phase, jobTitle, jobMeta);
    currentWrapper.append(currentCard);
  } else {
    const idleCard = el(doc, "div", "jobpilot-card");
    const idleText = el(doc, "p", undefined, t("home.currentIdle"));
    idleText.style.margin = "0";
    idleText.style.color = "var(--jp-text-secondary)";
    idleCard.append(idleText);
    currentWrapper.append(idleCard);
  }
  container.append(currentWrapper);

  // --- 7. Today's Progress Numbers ----------------------------------------
  const statsWrapper = el(doc, "div", "jobpilot-section");
  statsWrapper.append(el(doc, "span", "jobpilot-section-title", t("home.todayProgress")));

  const statsGrid = el(doc, "div", "jobpilot-stats-grid");

  const statLabelsMap: Record<string, string> = {
    Scanned: t("home.scanned"),
    Accepted: t("home.accepted"),
    Applied: t("home.applied"),
    Skipped: t("home.skipped"),
    Blocked: t("home.blocked"),
    Failed: t("home.failed"),
  };

  for (const tile of input.stats) {
    const card = el(doc, "div", "jobpilot-stat-card");
    card.setAttribute("data-key", tile.label.toLowerCase());

    const label = el(doc, "span", "jobpilot-stat-label", statLabelsMap[tile.label] ?? tile.label);
    const value = el(doc, "span", "jobpilot-stat-value", String(tile.value));

    card.append(label, value);
    statsGrid.append(card);
  }

  statsWrapper.append(statsGrid);
  container.append(statsWrapper);

  return container;
};
