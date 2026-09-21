/**
 * Home page: the three-step batch flow.
 *
 * The core loop is exactly three steps, all on this page:
 * - ① 搜索岗位: scan the current listing and filter by the active intent
 * - ② 选择职位: review the discovered matches and uncheck what to skip
 * - ③ 批量投递: start / pause / resume / stop the gated batch run
 *
 * Everything else stays calm and out of the way: a login prompt when BOSS
 * signs the user out, a blocked / human-verification card, a message banner,
 * and pending decisions.
 */

import { el } from "../components/chips";
import { t } from "../i18n";
import type { BlockedView, MatchRowView, PendingDecisionView, UiCallbacks } from "../view-model";

export interface HomePageInput {
  readonly message?:
    | {
        readonly tone: "info" | "warn" | "error" | "success";
        readonly text: string;
      }
    | undefined;
  readonly blocked?: BlockedView | undefined;
  readonly decisions: readonly PendingDecisionView[];
  readonly callbacks: UiCallbacks;
  /** Discovered matches for step ②. Empty until the first scan. */
  readonly matches?: readonly MatchRowView[] | undefined;
  /** Human-readable result of the last scan, shown under step ①. */
  readonly discoveryNote?: string | undefined;
  readonly isLoggedIn?: boolean | undefined;
  readonly pageKind?: string | undefined;
}

export const renderHomePage = (doc: Document, input: HomePageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-home");

  // --- 1. Login Guidance Prompt (Calm & Non-intrusive) ---------------------
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

  // --- 2. Blocked / Human Verification Card -------------------------------
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

  // --- 3. Decisions Card (e.g. uncertain send, draft detected) ------------
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

  // --- 4. The Three-Step Batch Flow ----------------------------------------
  const stepsWrapper = el(doc, "div", "jobpilot-section");
  stepsWrapper.append(el(doc, "span", "jobpilot-section-title", t("home.stepsTitle")));

  // Step ①: 搜索岗位
  const step1 = el(doc, "div", "jobpilot-card");
  const step1Header = el(doc, "div", "jobpilot-step-header");
  step1Header.style.display = "flex";
  step1Header.style.alignItems = "center";
  step1Header.style.gap = "8px";
  const step1Badge = el(doc, "span", "jobpilot-step-badge", "①");
  step1Badge.style.fontSize = "18px";
  step1Header.append(step1Badge, el(doc, "span", "jobpilot-step-title", t("home.step1Title")));
  step1.append(step1Header);
  const step1Hint = el(doc, "p", "jobpilot-step-hint", t("home.step1Hint"));
  step1Hint.style.margin = "4px 0 8px";
  step1Hint.style.color = "var(--jp-text-secondary)";
  step1.append(step1Hint);

  const scanBtn = el(doc, "button", "jobpilot-btn", t("home.step1Button"));
  scanBtn.type = "button";
  scanBtn.setAttribute("data-action", "discover-jobs");
  scanBtn.setAttribute("data-variant", "primary");
  scanBtn.addEventListener("click", () => {
    input.callbacks.discover();
  });
  step1.append(scanBtn);

  if (input.discoveryNote !== undefined) {
    const note = el(doc, "p", "jobpilot-step-note", input.discoveryNote);
    note.style.margin = "8px 0 0";
    note.style.color = "var(--jp-text-secondary)";
    step1.append(note);
  }
  stepsWrapper.append(step1);

  const matches = input.matches ?? [];

  // Step ②: 选择职位 (only once something has been discovered)
  if (matches.length > 0) {
    const step2 = el(doc, "div", "jobpilot-card");
    step2.style.marginTop = "8px";
    const step2Header = el(doc, "div", "jobpilot-step-header");
    step2Header.style.display = "flex";
    step2Header.style.alignItems = "center";
    step2Header.style.gap = "8px";
    const step2Badge = el(doc, "span", "jobpilot-step-badge", "②");
    step2Badge.style.fontSize = "18px";
    step2Header.append(step2Badge, el(doc, "span", "jobpilot-step-title", t("home.step2Title")));
    step2.append(step2Header);

    const list = el(doc, "div", "jobpilot-step-match-list");
    list.style.maxHeight = "180px";
    list.style.overflowY = "auto";
    list.style.marginTop = "8px";
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "4px";

    for (const match of matches.slice(0, 20)) {
      const row = el(doc, "label", "jobpilot-step-match-row");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      row.style.fontSize = "13px";
      const checkbox = el(doc, "input");
      checkbox.type = "checkbox";
      checkbox.checked = match.selected;
      checkbox.setAttribute("data-job-id", match.jobId);
      checkbox.addEventListener("change", () => {
        input.callbacks.onToggleMatchSelect?.(match.jobId);
      });
      const labelText = el(
        doc,
        "span",
        undefined,
        `${match.title} · ${match.company} · ${match.score}分`,
      );
      row.append(checkbox, labelText);
      list.append(row);
    }
    step2.append(list);

    const step2Hint = el(doc, "p", "jobpilot-step-hint", t("home.step2Hint"));
    step2Hint.style.margin = "8px 0 0";
    step2Hint.style.color = "var(--jp-text-secondary)";
    step2.append(step2Hint);
    stepsWrapper.append(step2);
  }

  // Step ③: 批量投递
  const step3 = el(doc, "div", "jobpilot-card");
  step3.style.marginTop = "8px";
  const step3Header = el(doc, "div", "jobpilot-step-header");
  step3Header.style.display = "flex";
  step3Header.style.alignItems = "center";
  step3Header.style.gap = "8px";
  const step3Badge = el(doc, "span", "jobpilot-step-badge", "③");
  step3Badge.style.fontSize = "18px";
  step3Header.append(step3Badge, el(doc, "span", "jobpilot-step-title", t("home.step3Title")));
  step3.append(step3Header);

  const selectedCount = matches.filter((match) => match.selected).length;
  const step3Count = el(
    doc,
    "p",
    "jobpilot-step-count",
    t("home.step3Selected", { count: selectedCount }),
  );
  step3Count.style.margin = "4px 0 8px";
  step3Count.style.color = "var(--jp-text-secondary)";
  step3.append(step3Count);

  const step3Actions = el(doc, "div", "jobpilot-step-actions");
  step3Actions.style.display = "flex";
  step3Actions.style.flexWrap = "wrap";
  step3Actions.style.gap = "6px";

  const startBtn = el(doc, "button", "jobpilot-btn", t("home.step3Start"));
  startBtn.type = "button";
  startBtn.setAttribute("data-action", "start-batch");
  startBtn.setAttribute("data-variant", "primary");
  startBtn.addEventListener("click", () => {
    input.callbacks.start();
  });

  const pauseBtn = el(doc, "button", "jobpilot-btn", t("common.pause"));
  pauseBtn.type = "button";
  pauseBtn.setAttribute("data-action", "pause-batch");
  pauseBtn.addEventListener("click", () => {
    input.callbacks.pause();
  });

  const resumeBtn = el(doc, "button", "jobpilot-btn", t("common.resume"));
  resumeBtn.type = "button";
  resumeBtn.setAttribute("data-action", "resume-batch");
  resumeBtn.addEventListener("click", () => {
    input.callbacks.resume();
  });

  const stopBtn = el(doc, "button", "jobpilot-btn", t("common.stop"));
  stopBtn.type = "button";
  stopBtn.setAttribute("data-action", "stop-batch");
  stopBtn.setAttribute("data-variant", "danger");
  stopBtn.addEventListener("click", () => {
    input.callbacks.stop();
  });

  step3Actions.append(startBtn, pauseBtn, resumeBtn, stopBtn);
  step3.append(step3Actions);

  const step3Hint = el(doc, "p", "jobpilot-step-hint", t("home.step3Hint"));
  step3Hint.style.margin = "8px 0 0";
  step3Hint.style.color = "var(--jp-text-secondary)";
  step3.append(step3Hint);
  stepsWrapper.append(step3);

  container.append(stepsWrapper);

  return container;
};
