/**
 * JobPilot main panel shell.
 *
 * Provides:
 * - Shadow DOM style isolation
 * - Calm warm pink theme
 * - Chinese-first i18n support
 * - Draggable header with boundary clamping
 * - Multi-handle resizable panel
 * - Persistent layout geometry (restored & clamped on reload)
 * - Responsive adaptations (compact / normal / large)
 * - Accessible controls and focus states
 */

import { onLocaleChange, t } from "./i18n";
import { createDragController } from "./layout/drag";
import {
  clampGeometry,
  GEOMETRY_LIMITS,
  getSizeCategory,
  type StoredGeometryInput,
} from "./layout/geometry";
import { createResizeController } from "./layout/resize";
import { PANEL_CSS } from "./theme/styles";
import type { PanelTab, PanelViewModel, UiCallbacks } from "./view-model";

export interface PanelOptions {
  readonly document: Document;
  readonly version: string;
  readonly callbacks: UiCallbacks;
  readonly startCollapsed?: boolean | undefined;
  readonly geometry?: StoredGeometryInput | undefined;
}

export interface Panel {
  readonly host: HTMLElement;
  render(view: PanelViewModel): void;
  toast(tone: "info" | "warn" | "error" | "success", message: string): void;
  expand(): void;
  collapse(): void;
  resetLayout(): void;
  readonly expanded: boolean;
  dispose(): void;
}

const TAB_DEFS: readonly { readonly id: PanelTab; readonly key: string }[] = [
  { id: "home", key: "nav.home" },
  { id: "search", key: "nav.search" },
  { id: "matches", key: "nav.matches" },
  { id: "queue", key: "nav.queue" },
  { id: "history", key: "nav.history" },
  { id: "rules", key: "nav.rules" },
  { id: "messages", key: "nav.messages" },
  { id: "settings", key: "nav.settings" },
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

export const createPanel = (options: PanelOptions): Panel => {
  const doc = options.document;
  const callbacks = options.callbacks;

  const host = doc.createElement("div");
  host.setAttribute("data-jobpilot-host", "");
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("position", "static", "important");

  const useShadow = typeof host.attachShadow === "function";
  const root: ShadowRoot | HTMLElement = useShadow ? host.attachShadow({ mode: "open" }) : host;

  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  root.append(style);

  // --- 1. Launcher Pill ----------------------------------------------------
  const launcher = el(doc, "div", "jobpilot-launcher");
  launcher.setAttribute("role", "button");
  launcher.setAttribute("tabindex", "0");
  launcher.setAttribute("aria-label", t("launcher.openAria"));

  const dot = el(doc, "span", "jobpilot-dot");
  dot.setAttribute("data-state", "idle");

  const monogram = el(doc, "span", "jobpilot-launcher-monogram", "JP");
  const launcherLabel = el(doc, "span", "jobpilot-launcher-label", t("launcher.idle"));
  const launcherCount = el(doc, "span", "jobpilot-launcher-count", "");
  launcherCount.classList.add("jobpilot-hidden");

  launcher.append(dot, monogram, launcherLabel, launcherCount);

  // --- 2. Main Panel Shell ------------------------------------------------
  const panelEl = el(doc, "div", "jobpilot-root");
  panelEl.setAttribute("data-size", "normal");

  // Header
  const header = el(doc, "div", "jobpilot-header");
  header.setAttribute("role", "region");
  header.setAttribute("aria-label", "JobPilot Header");

  const title = el(doc, "span", "jobpilot-title");
  const logo = el(doc, "span", "jobpilot-logo-badge", "JobPilot");
  const versionTag = el(doc, "span", "jobpilot-version-tag", `v${options.version}`);
  title.append(logo, versionTag);

  const modeChip = el(doc, "span", "jobpilot-mode-chip", t("header.modeAssist"));
  const safetyChip = el(doc, "span", "jobpilot-safety-chip", t("header.safetySafe"));
  safetyChip.setAttribute("data-safety", "safe");

  const pageChip = el(doc, "span", "jobpilot-page-chip", "job-list");
  pageChip.setAttribute("data-page-kind", "job-list");

  const collapseBtn = el(doc, "button", "jobpilot-header-btn", "—");
  collapseBtn.type = "button";
  collapseBtn.setAttribute("data-action", "collapse");
  collapseBtn.setAttribute("aria-label", t("header.collapseAria"));
  collapseBtn.title = t("header.collapseAria");

  header.append(title, modeChip, pageChip, safetyChip, collapseBtn);

  // Navigation Tabs
  const tabBar = el(doc, "div", "jobpilot-tabs");
  tabBar.setAttribute("role", "tablist");
  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  const panels = new Map<PanelTab, HTMLElement>();

  let activeTab: PanelTab = "home";

  for (const tab of TAB_DEFS) {
    const button = el(doc, "button", "jobpilot-tab", t(tab.key));
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("data-tab", tab.id);
    button.setAttribute("aria-selected", tab.id === activeTab ? "true" : "false");
    button.addEventListener("click", () => selectTab(tab.id));
    tabBar.append(button);
    tabButtons.set(tab.id, button);
  }

  // Diagnostics tab if diagnostic build
  const diagTabButton = el(doc, "button", "jobpilot-tab", t("nav.diagnostics"));
  diagTabButton.type = "button";
  diagTabButton.setAttribute("role", "tab");
  diagTabButton.setAttribute("data-tab", "diagnostics");
  diagTabButton.setAttribute("aria-selected", "false");
  diagTabButton.classList.add("jobpilot-hidden");
  diagTabButton.addEventListener("click", () => selectTab("diagnostics"));
  tabBar.append(diagTabButton);
  tabButtons.set("diagnostics", diagTabButton);

  const body = el(doc, "div", "jobpilot-body");

  const allTabs: PanelTab[] = [
    "home",
    "search",
    "matches",
    "queue",
    "history",
    "rules",
    "messages",
    "settings",
    "diagnostics",
  ];

  for (const tabId of allTabs) {
    const section = el(doc, "div", "jobpilot-panel");
    section.setAttribute("data-active", tabId === activeTab ? "true" : "false");
    section.setAttribute("data-panel", tabId);
    panels.set(tabId, section);
    body.append(section);
  }

  const selectTab = (id: PanelTab): void => {
    activeTab = id;
    for (const [tabId, button] of tabButtons) {
      button.setAttribute("aria-selected", tabId === id ? "true" : "false");
    }
    for (const [tabId, section] of panels) {
      section.setAttribute("data-active", tabId === id ? "true" : "false");
    }
  };

  // Action Bar
  const actions = el(doc, "div", "jobpilot-actions");

  const discoverBtn = el(doc, "button", "jobpilot-btn", t("common.discover"));
  discoverBtn.type = "button";
  discoverBtn.setAttribute("data-action", "discover");
  discoverBtn.addEventListener("click", () => callbacks.discover());

  const startBtn = el(doc, "button", "jobpilot-btn", t("common.start"));
  startBtn.type = "button";
  startBtn.setAttribute("data-action", "start");
  startBtn.setAttribute("data-variant", "primary");
  startBtn.addEventListener("click", () => callbacks.start());

  const pauseBtn = el(doc, "button", "jobpilot-btn", t("common.pause"));
  pauseBtn.type = "button";
  pauseBtn.setAttribute("data-action", "pause");
  pauseBtn.addEventListener("click", () => callbacks.pause());

  const resumeBtn = el(doc, "button", "jobpilot-btn", t("common.resume"));
  resumeBtn.type = "button";
  resumeBtn.setAttribute("data-action", "resume");
  resumeBtn.addEventListener("click", () => callbacks.resume());

  const recheckBtn = el(doc, "button", "jobpilot-btn", t("common.recheck"));
  recheckBtn.type = "button";
  recheckBtn.setAttribute("data-action", "recheck");
  recheckBtn.addEventListener("click", () => callbacks.recheck());

  const skipBtn = el(doc, "button", "jobpilot-btn", t("common.skip"));
  skipBtn.type = "button";
  skipBtn.setAttribute("data-action", "skip");
  skipBtn.addEventListener("click", () => callbacks.skipCurrent());

  const stopBtn = el(doc, "button", "jobpilot-btn", t("common.stop"));
  stopBtn.type = "button";
  stopBtn.setAttribute("data-action", "stop");
  stopBtn.setAttribute("data-variant", "danger");
  stopBtn.addEventListener("click", () => callbacks.stop());

  actions.append(discoverBtn, startBtn, pauseBtn, resumeBtn, recheckBtn, skipBtn, stopBtn);

  panelEl.append(header, tabBar, body, actions);
  root.append(launcher, panelEl);

  // --- 3. Layout Geometry & Clamping ---------------------------------------
  let currentGeometry = clampGeometry(options.geometry, {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  });

  const applyGeometry = (geo: typeof currentGeometry): void => {
    panelEl.style.width = `${geo.width}px`;
    panelEl.style.height = `${geo.height}px`;
    panelEl.style.left = `${geo.x}px`;
    panelEl.style.top = `${geo.y}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
    panelEl.setAttribute("data-size", getSizeCategory(geo.width));
  };

  applyGeometry(currentGeometry);

  const onWindowResize = (): void => {
    currentGeometry = clampGeometry(
      {
        width: currentGeometry.width,
        height: currentGeometry.height,
        position: { x: currentGeometry.x, y: currentGeometry.y },
        collapsed: !expanded,
      },
      { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    );
    applyGeometry(currentGeometry);
  };
  window.addEventListener("resize", onWindowResize);

  // --- 4. Drag and Resize Controllers -------------------------------------
  const dragController = createDragController({
    handle: header,
    target: panelEl,
    getBounds: () => ({ width: currentGeometry.width, height: currentGeometry.height }),
    onPositionChange: (pos) => {
      currentGeometry = { ...currentGeometry, x: pos.x, y: pos.y };
    },
    onDragEnd: (pos) => {
      currentGeometry = { ...currentGeometry, x: pos.x, y: pos.y };
      callbacks.onSaveLayout?.(currentGeometry);
    },
  });

  const resizeController = createResizeController({
    target: panelEl,
    doc,
    onResizeChange: (size) => {
      currentGeometry = {
        ...currentGeometry,
        width: size.width,
        height: size.height,
        ...(size.x !== undefined ? { x: size.x } : {}),
      };
    },
    onResizeEnd: (size) => {
      currentGeometry = {
        ...currentGeometry,
        width: size.width,
        height: size.height,
        ...(size.x !== undefined ? { x: size.x } : {}),
      };
      callbacks.onSaveLayout?.(currentGeometry);
    },
  });

  // --- 5. Collapse / Expand -----------------------------------------------
  let expanded = options.startCollapsed !== true && options.geometry?.collapsed !== true;

  const applyExpanded = (): void => {
    launcher.classList.toggle("jobpilot-hidden", expanded);
    panelEl.classList.toggle("jobpilot-hidden", !expanded);
  };

  const expand = (): void => {
    expanded = true;
    applyExpanded();
    currentGeometry = { ...currentGeometry, collapsed: false };
    callbacks.setCollapsed(false);
    callbacks.onSaveLayout?.(currentGeometry);
  };

  const collapse = (): void => {
    expanded = false;
    applyExpanded();
    currentGeometry = { ...currentGeometry, collapsed: true };
    callbacks.setCollapsed(true);
    callbacks.onSaveLayout?.(currentGeometry);
  };

  launcher.addEventListener("click", expand);
  launcher.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      expand();
    }
  });

  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    collapse();
  });

  // --- 6. Reset Layout ----------------------------------------------------
  const resetLayout = (): void => {
    currentGeometry = clampGeometry(
      {
        width: GEOMETRY_LIMITS.DEFAULT_WIDTH,
        height: GEOMETRY_LIMITS.DEFAULT_HEIGHT,
        position: "bottom-right",
        collapsed: false,
      },
      { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    );
    applyGeometry(currentGeometry);
    callbacks.onResetLayout?.();
    callbacks.onSaveLayout?.(currentGeometry);
  };

  // --- 7. Keyboard Shortcuts ----------------------------------------------
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

  // --- 8. Dynamic Locale Subscription -------------------------------------
  let lastViewModel: PanelViewModel | undefined;

  const updateLocalizedStrings = (): void => {
    launcher.setAttribute("aria-label", t("launcher.openAria"));
    collapseBtn.setAttribute("aria-label", t("header.collapseAria"));
    collapseBtn.title = t("header.collapseAria");

    for (const tab of TAB_DEFS) {
      const btn = tabButtons.get(tab.id);
      if (btn) btn.textContent = t(tab.key);
    }
    diagTabButton.textContent = t("nav.diagnostics");

    discoverBtn.textContent = t("common.discover");
    startBtn.textContent = t("common.start");
    pauseBtn.textContent = t("common.pause");
    resumeBtn.textContent = t("common.resume");
    recheckBtn.textContent = t("common.recheck");
    skipBtn.textContent = t("common.skip");
    stopBtn.textContent = t("common.stop");

    if (lastViewModel) {
      renderView(lastViewModel);
    }
  };

  const unsubLocale = onLocaleChange(() => {
    updateLocalizedStrings();
  });

  // --- 9. Toast -----------------------------------------------------------
  let toastEl: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  applyExpanded();

  const renderView = (view: PanelViewModel): void => {
    lastViewModel = view;

    dot.setAttribute("data-state", view.state);

    // Launcher text
    switch (view.state) {
      case "idle":
        launcherLabel.textContent = t("launcher.idle");
        break;
      case "paused":
        launcherLabel.textContent = t("launcher.paused");
        break;
      case "blocked":
        launcherLabel.textContent = t("launcher.blocked");
        break;
      case "failed":
        launcherLabel.textContent = t("launcher.failed");
        break;
      default:
        launcherLabel.textContent = t("launcher.running");
        break;
    }

    if (view.launcherCount) {
      launcherCount.textContent = view.launcherCount;
      launcherCount.classList.remove("jobpilot-hidden");
    } else {
      launcherCount.classList.add("jobpilot-hidden");
    }

    // Header Chips
    modeChip.textContent =
      view.mode === "automatic"
        ? t("header.modeAuto")
        : view.mode === "manual"
          ? t("header.modeManual")
          : t("header.modeAssist");

    pageChip.textContent = view.pageKind;
    pageChip.setAttribute("data-page-kind", view.pageKind);

    safetyChip.textContent = view.safetyLabel;
    safetyChip.setAttribute("data-safety", view.safety);

    // Diagnostic Tab visibility
    if (view.channel === "diagnostic" || view.sections.diagnostics !== undefined) {
      diagTabButton.classList.remove("jobpilot-hidden");
    }

    // Populate section contents
    for (const section of panels.values()) {
      section.replaceChildren();
    }

    for (const [tabId, section] of panels) {
      // Check for content in view.sections, mapping logs to search/home if needed
      const content = view.sections[tabId];
      if (content !== undefined) section.append(content);
    }

    // Action button states
    const canStart = !view.running;
    const canPause = view.running;
    const canResume = view.paused;
    const canSkip = view.running;
    const canStop = view.running || view.paused;

    discoverBtn.disabled = !canStart;
    startBtn.disabled = !canStart;
    pauseBtn.disabled = !canPause;
    resumeBtn.disabled = !canResume;
    skipBtn.disabled = !canSkip;
    stopBtn.disabled = !canStop;
  };

  return {
    host,

    render(view) {
      renderView(view);
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
    resetLayout,
    get expanded() {
      return expanded;
    },

    dispose() {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastEl?.remove();
      doc.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onWindowResize);
      dragController.dispose();
      resizeController.dispose();
      unsubLocale();
      host.remove();
    },
  };
};
