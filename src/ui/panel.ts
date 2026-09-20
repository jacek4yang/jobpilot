/**
 * JobPilot panel.
 *
 * Presentation only: it renders view models it is handed and reports user
 * intent through callbacks. It never reaches into automation, storage or the
 * platform adapter, which keeps the dependency direction UI -> Application.
 *
 * Isolation: the panel is mounted inside a shadow root when the environment
 * supports it, falling back to a scoped `.jobpilot-root` element. Either way
 * the host page's styles cannot reach in and JobPilot's cannot leak out.
 */

import { PANEL_CSS } from "./styles";
import type { PanelTab, PanelViewModel, UiCallbacks } from "./view-model";

export interface PanelOptions {
  readonly document: Document;
  /** Injected so the header version label never disagrees with the build. */
  readonly version: string;
  readonly callbacks: UiCallbacks;
  /** Start collapsed (the launcher is shown instead of the full panel). */
  readonly startCollapsed?: boolean;
}

export interface Panel {
  readonly host: HTMLElement;
  render(view: PanelViewModel): void;
  /** Shows a transient message. At most one is visible at a time. */
  toast(tone: "info" | "warn" | "error" | "success", message: string): void;
  expand(): void;
  collapse(): void;
  readonly expanded: boolean;
  dispose(): void;
}

const TABS: readonly { readonly id: PanelTab; readonly label: string }[] = [
  { id: "search", label: "Search" },
  { id: "matches", label: "Matches" },
  { id: "queue", label: "Queue" },
  { id: "history", label: "History" },
  { id: "rules", label: "Rules" },
  { id: "messages", label: "Messages" },
  { id: "settings", label: "Settings" },
  { id: "logs", label: "Logs" },
];

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

/**
 * Creates the panel.
 *
 * Uses Shadow DOM so host styles cannot affect the panel. The stylesheet is
 * still scoped with a `jobpilot-` prefix, so the fallback path is equally safe.
 */
export const createPanel = (options: PanelOptions): Panel => {
  const doc = options.document;
  const callbacks = options.callbacks;

  const host = doc.createElement("div");
  host.setAttribute("data-jobpilot-host", "");
  // Keep the host itself out of the page's layout and stacking context.
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("position", "static", "important");

  const useShadow = typeof host.attachShadow === "function";
  const root: ShadowRoot | HTMLElement = useShadow ? host.attachShadow({ mode: "open" }) : host;

  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  root.append(style);

  // --- Launcher -----------------------------------------------------------
  const launcher = el(doc, "div", "jobpilot-launcher");
  launcher.setAttribute("role", "button");
  launcher.setAttribute("tabindex", "0");
  launcher.setAttribute("aria-label", "Open JobPilot");
  const dot = el(doc, "span", "jobpilot-dot");
  dot.setAttribute("data-state", "idle");
  const monogram = el(doc, "span", "jobpilot-launcher-monogram", "JP");
  const launcherCount = el(doc, "span", "jobpilot-launcher-count", "");
  launcher.append(dot, monogram, launcherCount);

  // --- Panel shell --------------------------------------------------------
  const panelEl = el(doc, "div", "jobpilot-root");

  const header = el(doc, "div", "jobpilot-header");
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-label", "Collapse JobPilot");
  const title = el(doc, "span", "jobpilot-title", `JobPilot ${options.version}`);
  const modeChip = el(doc, "span", "jobpilot-mode-chip", "assist");
  const safetyChip = el(doc, "span", "jobpilot-safety-chip", "Safe");
  safetyChip.setAttribute("data-safety", "safe");
  // Exposed as a data attribute so the classification is machine-readable
  // rather than only being rendered as label copy.
  const pageChip = el(doc, "span", "jobpilot-page-chip", "unknown");
  pageChip.setAttribute("data-page-kind", "unknown");
  header.append(title, modeChip, pageChip, safetyChip);

  const tabBar = el(doc, "div", "jobpilot-tabs");
  tabBar.setAttribute("role", "tablist");
  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  const panels = new Map<PanelTab, HTMLElement>();

  for (const tab of TABS) {
    const button = el(doc, "button", "jobpilot-tab", tab.label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab.id === "search" ? "true" : "false");
    button.addEventListener("click", () => selectTab(tab.id));
    tabBar.append(button);
    tabButtons.set(tab.id, button);
  }

  const body = el(doc, "div", "jobpilot-body");
  for (const tab of TABS) {
    const section = el(doc, "div", "jobpilot-panel");
    section.setAttribute("data-active", tab.id === "search" ? "true" : "false");
    section.setAttribute("data-panel", tab.id);
    panels.set(tab.id, section);
    body.append(section);
  }

  const selectTab = (id: PanelTab): void => {
    for (const [tabId, button] of tabButtons) {
      button.setAttribute("aria-selected", tabId === id ? "true" : "false");
    }
    for (const [tabId, section] of panels) {
      section.setAttribute("data-active", tabId === id ? "true" : "false");
    }
  };

  // --- Action bar ---------------------------------------------------------
  const actions = el(doc, "div", "jobpilot-actions");
  const startBtn = el(doc, "button", "jobpilot-btn", "Start");
  startBtn.type = "button";
  startBtn.setAttribute("data-variant", "primary");
  startBtn.addEventListener("click", () => callbacks.start());

  const pauseBtn = el(doc, "button", "jobpilot-btn", "Pause");
  pauseBtn.type = "button";
  pauseBtn.addEventListener("click", () => callbacks.pause());

  const resumeBtn = el(doc, "button", "jobpilot-btn", "Resume");
  resumeBtn.type = "button";
  resumeBtn.addEventListener("click", () => callbacks.resume());

  const skipBtn = el(doc, "button", "jobpilot-btn", "Skip");
  skipBtn.type = "button";
  skipBtn.addEventListener("click", () => callbacks.skipCurrent());

  const stopBtn = el(doc, "button", "jobpilot-btn", "Stop");
  stopBtn.type = "button";
  stopBtn.setAttribute("data-variant", "danger");
  stopBtn.addEventListener("click", () => callbacks.stop());

  actions.append(startBtn, pauseBtn, resumeBtn, skipBtn, stopBtn);

  panelEl.append(header, tabBar, body, actions);
  root.append(launcher, panelEl);

  // --- Collapse / expand --------------------------------------------------
  let expanded = options.startCollapsed !== true;
  const applyExpanded = (): void => {
    launcher.classList.toggle("jobpilot-hidden", expanded);
    panelEl.classList.toggle("jobpilot-hidden", !expanded);
  };

  const expand = (): void => {
    expanded = true;
    applyExpanded();
    callbacks.setCollapsed(false);
  };
  const collapse = (): void => {
    expanded = false;
    applyExpanded();
    callbacks.setCollapsed(true);
  };

  launcher.addEventListener("click", expand);
  launcher.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      expand();
    }
  });
  header.addEventListener("click", collapse);
  header.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      collapse();
    }
  });

  // --- Keyboard shortcuts -------------------------------------------------
  // Registered on the panel only, and never while focus is inside a text
  // field, so JobPilot cannot interfere with normal typing on the host page.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!expanded) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
    }
    if (event.key === "Escape") {
      collapse();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "p" || event.key === "P") callbacks.pause();
    if (event.key === "s" || event.key === "S") callbacks.skipCurrent();
  };
  doc.addEventListener("keydown", onKeyDown);

  // --- Toast --------------------------------------------------------------
  let toastEl: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  applyExpanded();

  return {
    host,

    render(view) {
      dot.setAttribute("data-state", view.state);
      modeChip.textContent = view.mode;
      pageChip.textContent = view.pageKind;
      pageChip.setAttribute("data-page-kind", view.pageKind);
      safetyChip.textContent = view.safetyLabel;
      safetyChip.setAttribute("data-safety", view.safety);

      launcherCount.textContent = view.launcherCount;

      for (const section of panels.values()) {
        section.replaceChildren();
      }

      for (const [tabId, section] of panels) {
        const content = view.sections[tabId];
        if (content !== undefined) section.append(content);
      }

      const canStart = !view.running;
      const canPause = view.running;
      const canResume = view.paused;
      const canSkip = view.running;
      const canStop = view.running || view.paused;

      startBtn.disabled = !canStart;
      pauseBtn.disabled = !canPause;
      resumeBtn.disabled = !canResume;
      skipBtn.disabled = !canSkip;
      stopBtn.disabled = !canStop;
    },

    toast(tone, message) {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastEl?.remove();
      const node = el(doc, "div", "jobpilot-toast", message);
      node.setAttribute("data-tone", tone);
      root.append(node);
      toastEl = node;
      toastTimer = setTimeout(() => {
        node.remove();
        if (toastEl === node) toastEl = undefined;
        toastTimer = undefined;
      }, 6_000);
    },

    expand,
    collapse,
    get expanded() {
      return expanded;
    },

    dispose() {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastEl?.remove();
      doc.removeEventListener("keydown", onKeyDown);
      host.remove();
    },
  };
};
