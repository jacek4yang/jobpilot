/**
 * Floating blocking modal for human-verification states.
 *
 * When BOSS raises a challenge — CAPTCHA, risk control, expired login,
 * unrecognised page, rate limiting, or the human-gated 立即沟通 click — the
 * panel surfaces this modal above everything else so the user sees it no
 * matter which tab is active. The recovery stays strictly two-step: the
 * primary button only re-validates the page (recheck); resuming remains a
 * separate, explicit action elsewhere in the panel. For that reason the
 * modal deliberately offers no Escape/close affordance — the operator must
 * re-check or stop. Collapsing the panel is still possible: the launcher
 * pill then carries the 「需要处理」 badge until the block resolves.
 *
 * The modal renders inside the panel's shadow root (the caller appends `el`
 * to the panel), so host-page CSS cannot reach it and it cannot leak out.
 */

import { createIcon, ICONS } from "./components/icons";
import { t } from "./i18n";

/**
 * Pause-reason kinds that surface the floating modal. User-initiated pauses
 * and internal bookkeeping pauses (watchdog, page-changed, ...) keep the
 * in-flow card instead — they need no human verification.
 */
const BLOCKING_MODAL_KINDS: readonly string[] = [
  "captcha",
  "risk-control",
  "login-expired",
  "unknown-dom",
  "rate-limited",
  "needs-human-click",
];

export const isBlockingModalKind = (kind: string): boolean => BLOCKING_MODAL_KINDS.includes(kind);

export interface BlockingModalInput {
  readonly title: string;
  readonly body: string;
  /** Step one of the two-step recovery: validate the page, never resume. */
  readonly onRecheck: () => void;
  readonly onStop: () => void;
}

export interface BlockingModal {
  readonly el: HTMLElement;
  close(): void;
}

export const createBlockingModal = (doc: Document, input: BlockingModalInput): BlockingModal => {
  const overlay = doc.createElement("div");
  overlay.className = "jobpilot-modal-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", input.title);
  overlay.setAttribute("tabindex", "-1");

  const card = doc.createElement("div");
  card.className = "jobpilot-modal-card";

  const icon = createIcon(doc, ICONS.alert);
  icon.classList.add("jobpilot-modal-icon");

  const title = doc.createElement("h2");
  title.className = "jobpilot-modal-title";
  title.textContent = input.title;

  const body = doc.createElement("p");
  body.className = "jobpilot-modal-body";
  body.textContent = input.body;

  const actions = doc.createElement("div");
  actions.className = "jobpilot-modal-actions";

  const recheckBtn = doc.createElement("button");
  recheckBtn.type = "button";
  recheckBtn.className = "jobpilot-btn";
  recheckBtn.setAttribute("data-variant", "primary");
  recheckBtn.setAttribute("data-action", "recheck");
  recheckBtn.textContent = t("modal.recheckButton");

  const stopBtn = doc.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "jobpilot-btn";
  stopBtn.setAttribute("data-variant", "danger");
  stopBtn.setAttribute("data-action", "stop");
  stopBtn.textContent = t("modal.stopButton");

  actions.append(recheckBtn, stopBtn);
  card.append(icon, title, body, actions);
  overlay.append(card);

  const onOverlayKeyDown = (event: KeyboardEvent): void => {
    // Enter on the focused overlay re-runs validation. When focus sits on a
    // button, the button keeps its native behaviour (no double recheck).
    if (event.target !== overlay) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    input.onRecheck();
  };

  overlay.addEventListener("keydown", onOverlayKeyDown);
  recheckBtn.addEventListener("click", input.onRecheck);
  stopBtn.addEventListener("click", input.onStop);

  return {
    el: overlay,
    close() {
      overlay.removeEventListener("keydown", onOverlayKeyDown);
      overlay.remove();
    },
  };
};

/**
 * Refreshes the mutable texts of an open modal in place, so re-renders and
 * locale switches never steal focus by rebuilding it.
 */
export const syncBlockingModal = (modalEl: HTMLElement, body: string): void => {
  modalEl.setAttribute("aria-label", t("modal.title"));
  const titleEl = modalEl.querySelector(".jobpilot-modal-title");
  if (titleEl !== null) titleEl.textContent = t("modal.title");
  const bodyEl = modalEl.querySelector(".jobpilot-modal-body");
  if (bodyEl !== null) bodyEl.textContent = body;
  const recheckBtn = modalEl.querySelector('[data-action="recheck"]');
  if (recheckBtn !== null) recheckBtn.textContent = t("modal.recheckButton");
  const stopBtn = modalEl.querySelector('[data-action="stop"]');
  if (stopBtn !== null) stopBtn.textContent = t("modal.stopButton");
};
