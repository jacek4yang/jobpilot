/**
 * Scoped styles for JobPilot UI.
 *
 * All styles are contained inside the JobPilot Shadow DOM, using custom properties
 * and clean semantic classes.
 */

import { THEME_VARIABLES } from "./theme";

export const PANEL_CSS = `
:host, .jobpilot-root, .jobpilot-launcher, .jobpilot-toast {
  ${THEME_VARIABLES}
}

.jobpilot-root {
  all: initial;
  position: fixed;
  top: 84px;
  right: 20px;
  z-index: var(--jp-z-panel);
  display: flex;
  flex-direction: column;
  width: 480px;
  height: 640px;
  min-width: 340px;
  min-height: 400px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  font-family: var(--jp-font);
  font-size: 12px;
  line-height: 1.5;
  color: var(--jp-text);
  background: var(--jp-surface);
  border: 1px solid var(--jp-border);
  border-radius: var(--jp-radius-lg);
  box-shadow: var(--jp-shadow-panel);
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  box-sizing: border-box;
}

.jobpilot-root *, .jobpilot-root *::before, .jobpilot-root *::after {
  box-sizing: border-box;
}

/* --- Focus states for Accessibility --- */
.jobpilot-root button:focus-visible,
.jobpilot-root input:focus-visible,
.jobpilot-root select:focus-visible,
.jobpilot-root textarea:focus-visible,
.jobpilot-root [tabindex]:focus-visible,
.jobpilot-launcher:focus-visible {
  outline: 2px solid var(--jp-border-focus);
  outline-offset: 2px;
}

/* --- Floating Launcher ---------------------------------------------------- */
.jobpilot-launcher {
  all: initial;
  position: fixed;
  top: 84px;
  right: 20px;
  z-index: var(--jp-z-panel);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-family: var(--jp-font);
  font-size: 12px;
  font-weight: 500;
  color: var(--jp-text);
  background: var(--jp-surface);
  border: 1px solid var(--jp-border);
  border-radius: var(--jp-radius-full);
  box-shadow: var(--jp-shadow-launcher);
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}

.jobpilot-launcher:hover {
  background: var(--jp-surface-soft);
  box-shadow: 0 6px 22px rgba(160, 90, 115, 0.2);
  transform: translateY(-1px);
}

.jobpilot-launcher-monogram {
  font-weight: 700;
  color: var(--jp-primary);
  letter-spacing: 0.04em;
}

.jobpilot-launcher-label {
  font-size: 12px;
  color: var(--jp-text);
}

.jobpilot-launcher-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--jp-text-secondary);
  background: var(--jp-primary-soft);
  padding: 1px 7px;
  border-radius: var(--jp-radius-full);
}

.jobpilot-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--jp-text-muted);
  flex: none;
  transition: background-color 0.2s ease;
}

.jobpilot-dot[data-state="idle"] { background: var(--jp-text-muted); }
.jobpilot-dot[data-state="scanning"],
.jobpilot-dot[data-state="evaluating"],
.jobpilot-dot[data-state="opening"],
.jobpilot-dot[data-state="validating"],
.jobpilot-dot[data-state="applying"],
.jobpilot-dot[data-state="verifying"],
.jobpilot-dot[data-state="cooldown"],
.jobpilot-dot[data-state="discovering"],
.jobpilot-dot[data-state="executing"] { background: var(--jp-primary); }
.jobpilot-dot[data-state="paused"],
.jobpilot-dot[data-state="reviewing"] { background: var(--jp-warning); }
.jobpilot-dot[data-state="blocked"],
.jobpilot-dot[data-state="failed"] { background: var(--jp-danger); }

/* --- Header ------------------------------------------------------------- */
.jobpilot-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--jp-surface-soft);
  border-bottom: 1px solid var(--jp-border-subtle);
  cursor: grab;
  user-select: none;
  flex: none;
}

.jobpilot-header:active {
  cursor: grabbing;
}

.jobpilot-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--jp-text);
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}

.jobpilot-logo-badge {
  color: var(--jp-primary);
  font-weight: 800;
}

.jobpilot-version-tag {
  font-size: 10px;
  font-weight: 500;
  color: var(--jp-text-muted);
  margin-left: 2px;
}

.jobpilot-mode-chip,
.jobpilot-safety-chip,
.jobpilot-page-chip {
  padding: 2px 8px;
  border-radius: var(--jp-radius-full);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.jobpilot-mode-chip {
  background: var(--jp-primary-soft);
  color: var(--jp-primary);
}

.jobpilot-safety-chip[data-safety="safe"] {
  background: var(--jp-chip-safe-bg);
  color: var(--jp-chip-safe-text);
}
.jobpilot-safety-chip[data-safety="auto"] {
  background: var(--jp-chip-auto-bg);
  color: var(--jp-chip-auto-text);
}
.jobpilot-safety-chip[data-safety="paused"] {
  background: var(--jp-chip-paused-bg);
  color: var(--jp-chip-paused-text);
}
.jobpilot-safety-chip[data-safety="blocked"] {
  background: var(--jp-chip-blocked-bg);
  color: var(--jp-chip-blocked-text);
}

.jobpilot-page-chip {
  background: var(--jp-chip-page-bg);
  color: var(--jp-chip-page-text);
}

.jobpilot-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--jp-radius-sm);
  color: var(--jp-text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.jobpilot-header-btn:hover {
  background: var(--jp-surface-hover);
  color: var(--jp-text);
}

/* --- Tabs --------------------------------------------------------------- */
.jobpilot-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 10px 0;
  background: var(--jp-surface);
  border-bottom: 1px solid var(--jp-border-subtle);
  overflow-x: auto;
  scrollbar-width: none;
  flex: none;
}

.jobpilot-tabs::-webkit-scrollbar {
  display: none;
}

.jobpilot-tab {
  position: relative;
  padding: 7px 11px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--jp-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--jp-radius-sm) var(--jp-radius-sm) 0 0;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.jobpilot-tab:hover {
  color: var(--jp-text);
  background: var(--jp-surface-hover);
}

.jobpilot-tab[aria-selected="true"] {
  color: var(--jp-primary);
  font-weight: 600;
}

.jobpilot-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 10px;
  right: 10px;
  height: 2px;
  background: var(--jp-primary);
  border-radius: 2px;
}

/* --- Body & Pages ------------------------------------------------------- */
.jobpilot-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  background: var(--jp-bg);
  padding: 14px;
}

.jobpilot-panel {
  display: none;
}

.jobpilot-panel[data-active="true"] {
  display: block;
}

.jobpilot-section {
  margin-bottom: 14px;
}

.jobpilot-section:last-child {
  margin-bottom: 0;
}

.jobpilot-section-title {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--jp-text-secondary);
  letter-spacing: 0.02em;
}

/* --- Soft Cards --------------------------------------------------------- */
.jobpilot-card {
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  padding: 12px 14px;
  margin-bottom: 10px;
  box-shadow: var(--jp-shadow-card);
}

.jobpilot-card:last-child {
  margin-bottom: 0;
}

/* --- Greeting Card (Home) ----------------------------------------------- */
.jobpilot-greeting-card {
  background: linear-gradient(135deg, #fff8f9 0%, #ffffff 100%);
  border: 1px solid var(--jp-primary-border);
  border-radius: var(--jp-radius-md);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.jobpilot-greeting-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--jp-text);
  margin: 0;
  line-height: 1.5;
}

.jobpilot-greeting-sub {
  font-size: 12px;
  color: var(--jp-text-secondary);
  margin: 4px 0 0;
}

/* --- Current Action Card ------------------------------------------------ */
.jobpilot-current-card {
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-left: 4px solid var(--jp-primary);
  border-radius: var(--jp-radius-md);
  padding: 12px 14px;
  margin-bottom: 12px;
}

.jobpilot-current-phase {
  font-size: 11px;
  font-weight: 600;
  color: var(--jp-primary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.jobpilot-current-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jp-text);
  word-break: break-word;
}

.jobpilot-current-meta {
  font-size: 12px;
  color: var(--jp-text-secondary);
  margin-top: 2px;
}

/* --- Stats Grid (Home) -------------------------------------------------- */
.jobpilot-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}

.jobpilot-stat-card {
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  padding: 10px 8px;
  text-align: center;
}

.jobpilot-stat-label {
  display: block;
  font-size: 11px;
  color: var(--jp-text-secondary);
  margin-bottom: 4px;
}

.jobpilot-stat-value {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: var(--jp-text);
}

.jobpilot-stat-card[data-key="accepted"] .jobpilot-stat-value {
  color: var(--jp-primary);
}

.jobpilot-stat-card[data-key="applied"] .jobpilot-stat-value {
  color: var(--jp-success);
}

/* --- Blocked & Human Verification Card ---------------------------------- */
.jobpilot-blocked-card {
  background: var(--jp-danger-bg);
  border: 1px solid var(--jp-danger-border);
  border-radius: var(--jp-radius-md);
  padding: 16px;
  margin-bottom: 14px;
}

.jobpilot-blocked-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--jp-danger);
  display: flex;
  align-items: center;
  gap: 6px;
}

.jobpilot-blocked-body {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--jp-text);
  line-height: 1.6;
  white-space: pre-line;
}

.jobpilot-blocked-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* --- Pending Decisions -------------------------------------------------- */
.jobpilot-decision-card {
  background: var(--jp-warning-bg);
  border: 1px solid var(--jp-warning-border);
  border-radius: var(--jp-radius-md);
  padding: 14px;
  margin-bottom: 12px;
}

.jobpilot-decision-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--jp-warning);
  margin-bottom: 4px;
}

.jobpilot-decision-message {
  font-size: 12px;
  color: var(--jp-text);
  margin-bottom: 10px;
  line-height: 1.5;
}

.jobpilot-decision-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* --- Match Job Cards ---------------------------------------------------- */
.jobpilot-match-card {
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  padding: 12px 14px;
  margin-bottom: 10px;
  box-shadow: var(--jp-shadow-card);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.jobpilot-match-card:hover {
  border-color: var(--jp-primary-border);
  box-shadow: 0 4px 12px rgba(160, 90, 115, 0.08);
}

.jobpilot-match-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.jobpilot-match-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jp-text);
  word-break: break-word;
}

.jobpilot-match-score-badge {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--jp-radius-full);
  background: var(--jp-primary-soft);
  color: var(--jp-primary);
}

.jobpilot-match-score-badge[data-band="high"] {
  background: var(--jp-success-bg);
  color: var(--jp-success);
}

.jobpilot-match-score-badge[data-band="low"] {
  background: var(--jp-surface-secondary);
  color: var(--jp-text-muted);
}

.jobpilot-match-meta {
  font-size: 12px;
  color: var(--jp-text-secondary);
  margin-bottom: 6px;
}

.jobpilot-match-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.jobpilot-reason-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: var(--jp-radius-sm);
  background: var(--jp-surface-secondary);
  color: var(--jp-text-secondary);
}

.jobpilot-reason-chip[data-sign="plus"] {
  background: var(--jp-success-bg);
  color: var(--jp-success);
}

.jobpilot-reason-chip[data-sign="minus"] {
  background: var(--jp-danger-bg);
  color: var(--jp-danger);
}

/* --- Queue & History Rows ----------------------------------------------- */
.jobpilot-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.jobpilot-item-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  margin-bottom: 8px;
  box-shadow: var(--jp-shadow-card);
}

.jobpilot-item-row:last-child {
  margin-bottom: 0;
}

.jobpilot-status-chip {
  flex: none;
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--jp-radius-full);
  font-size: 11px;
  font-weight: 600;
  background: var(--jp-surface-secondary);
  color: var(--jp-text-secondary);
  white-space: nowrap;
}

.jobpilot-status-chip[data-status="waiting"],
.jobpilot-status-chip[data-status="pending"] {
  background: #f0f3f6;
  color: #4a5568;
}

.jobpilot-status-chip[data-status="opening"],
.jobpilot-status-chip[data-status="checking"],
.jobpilot-status-chip[data-status="applying"],
.jobpilot-status-chip[data-status="verifying"],
.jobpilot-status-chip[data-status="running"] {
  background: var(--jp-primary-soft);
  color: var(--jp-primary);
}

.jobpilot-status-chip[data-status="completed"],
.jobpilot-status-chip[data-status="submitted"] {
  background: var(--jp-success-bg);
  color: var(--jp-success);
}

.jobpilot-status-chip[data-status="paused"] {
  background: var(--jp-warning-bg);
  color: var(--jp-warning);
}

.jobpilot-status-chip[data-status="blocked"],
.jobpilot-status-chip[data-status="failed"],
.jobpilot-status-chip[data-status="uncertain"] {
  background: var(--jp-danger-bg);
  color: var(--jp-danger);
}

.jobpilot-status-chip[data-status="skipped"] {
  background: var(--jp-surface-secondary);
  color: var(--jp-text-muted);
}

.jobpilot-item-main {
  flex: 1;
  min-width: 0;
}

.jobpilot-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jp-text);
  word-break: break-word;
}

.jobpilot-item-meta {
  font-size: 11px;
  color: var(--jp-text-secondary);
  margin-top: 2px;
  word-break: break-word;
}

/* --- Empty States ------------------------------------------------------- */
.jobpilot-empty-state {
  text-align: center;
  padding: 32px 16px;
  color: var(--jp-text-secondary);
}

.jobpilot-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--jp-text);
  margin: 0 0 6px;
}

.jobpilot-empty-sub {
  font-size: 12px;
  color: var(--jp-text-muted);
  margin: 0;
  line-height: 1.5;
}

/* --- Form Fields & Settings --------------------------------------------- */
.jobpilot-field-group {
  margin-bottom: 14px;
}

.jobpilot-field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--jp-text);
  margin-bottom: 4px;
}

.jobpilot-field-hint {
  font-size: 11px;
  color: var(--jp-text-muted);
  margin-top: 4px;
  line-height: 1.4;
}

.jobpilot-input,
.jobpilot-select,
.jobpilot-textarea {
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--jp-text);
  background: var(--jp-surface);
  border: 1px solid var(--jp-border);
  border-radius: var(--jp-radius-sm);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.jobpilot-input:focus,
.jobpilot-select:focus,
.jobpilot-textarea:focus {
  outline: none;
  border-color: var(--jp-border-focus);
  box-shadow: 0 0 0 2px var(--jp-primary-soft);
}

.jobpilot-textarea {
  min-height: 70px;
  resize: vertical;
}

.jobpilot-chips-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.jobpilot-filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--jp-radius-full);
  background: var(--jp-surface-secondary);
  border: 1px solid var(--jp-border-subtle);
  color: var(--jp-text);
  cursor: pointer;
  transition: all 0.15s ease;
}

.jobpilot-filter-chip[data-selected="true"] {
  background: var(--jp-primary-soft);
  border-color: var(--jp-primary-border);
  color: var(--jp-primary);
  font-weight: 600;
}

/* --- Action Bar (Bottom) ------------------------------------------------ */
.jobpilot-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  background: var(--jp-surface-soft);
  border-top: 1px solid var(--jp-border-subtle);
  flex: none;
}

.jobpilot-backup-actions,
.jobpilot-pref-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.jobpilot-btn {
  flex: 1;
  padding: 8px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--jp-text);
  background: var(--jp-surface);
  border: 1px solid var(--jp-border);
  border-radius: var(--jp-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  text-align: center;
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
}

.jobpilot-btn:hover:not(:disabled) {
  background: var(--jp-surface-hover);
  border-color: var(--jp-primary-border);
}

.jobpilot-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.jobpilot-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.jobpilot-btn[data-variant="primary"] {
  background: var(--jp-primary);
  border-color: var(--jp-primary);
  color: #ffffff;
}

.jobpilot-btn[data-variant="primary"]:hover:not(:disabled) {
  background: var(--jp-primary-hover);
  border-color: var(--jp-primary-hover);
}

.jobpilot-btn[data-variant="danger"] {
  background: var(--jp-danger-bg);
  border-color: var(--jp-danger-border);
  color: var(--jp-danger);
}

.jobpilot-btn[data-variant="danger"]:hover:not(:disabled) {
  background: #fbd6d9;
}

.jobpilot-btn[data-variant="subtle"] {
  background: transparent;
  border-color: transparent;
  color: var(--jp-primary);
}

.jobpilot-btn[data-variant="subtle"]:hover:not(:disabled) {
  background: var(--jp-primary-soft);
}

/* --- Resize Handles ----------------------------------------------------- */
.jobpilot-resize-handle {
  position: absolute;
  z-index: 20;
}

.jobpilot-resize-e {
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: ew-resize;
}

.jobpilot-resize-w {
  top: 0;
  left: 0;
  width: 6px;
  height: 100%;
  cursor: ew-resize;
}

.jobpilot-resize-s {
  bottom: 0;
  left: 0;
  width: 100%;
  height: 6px;
  cursor: ns-resize;
}

.jobpilot-resize-se {
  bottom: 0;
  right: 0;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
}

.jobpilot-resize-sw {
  bottom: 0;
  left: 0;
  width: 12px;
  height: 12px;
  cursor: nesw-resize;
}

.jobpilot-resize-indicator {
  position: absolute;
  bottom: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-right: 2px solid var(--jp-border);
  border-bottom: 2px solid var(--jp-border);
  pointer-events: none;
}

/* --- Diagnostics Grid --------------------------------------------------- */
.jobpilot-diag-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  padding: 10px 12px;
  margin-bottom: 12px;
}

.jobpilot-diag-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  padding: 3px 0;
  border-bottom: 1px solid var(--jp-border-subtle);
}

.jobpilot-diag-row:last-child {
  border-bottom: none;
}

.jobpilot-diag-label {
  color: var(--jp-text-secondary);
}

.jobpilot-diag-value {
  font-family: var(--jp-font-mono);
  font-weight: 600;
  color: var(--jp-text);
  word-break: break-all;
}

.jobpilot-diag-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}

/* --- Phase 2: Personal Job Workspace & Guidance ------------------------- */
.jobpilot-login-card {
  background: linear-gradient(135deg, #fff3f5 0%, #ffffff 100%);
  border: 1px solid var(--jp-primary-border);
  border-radius: var(--jp-radius-md);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.jobpilot-login-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.jobpilot-login-icon {
  font-size: 16px;
}

.jobpilot-login-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jp-text);
  margin: 0;
}

.jobpilot-login-desc {
  font-size: 12px;
  color: var(--jp-text-secondary);
  line-height: 1.5;
  margin: 0 0 10px;
  white-space: pre-line;
}

.jobpilot-login-actions {
  display: flex;
  gap: 8px;
}

.jobpilot-guidance-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}

.jobpilot-guidance-card {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--jp-surface);
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  padding: 10px 8px;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}

.jobpilot-guidance-card:hover {
  border-color: var(--jp-primary-border);
  background: var(--jp-surface-soft);
  transform: translateY(-1px);
}

.jobpilot-guidance-icon {
  font-size: 16px;
  flex: none;
}

.jobpilot-guidance-content {
  min-width: 0;
}

.jobpilot-guidance-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--jp-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jobpilot-guidance-meta {
  font-size: 11px;
  color: var(--jp-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jobpilot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.jobpilot-job-salary {
  font-size: 13px;
  font-weight: 700;
  color: var(--jp-primary);
  flex-shrink: 0;
}

.jobpilot-job-meta {
  font-size: 11px;
  color: var(--jp-text-secondary);
  margin-top: 4px;
}

/* --- Subnav inside Workspace ------------------------------------------- */
.jobpilot-subnav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--jp-border-subtle);
  padding-bottom: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.jobpilot-subnav::-webkit-scrollbar {
  display: none;
}

.jobpilot-subnav-btn {
  padding: 5px 10px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  color: var(--jp-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--jp-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.jobpilot-subnav-btn:hover {
  color: var(--jp-text);
  background: var(--jp-surface-hover);
}

.jobpilot-subnav-btn-active {
  color: var(--jp-primary);
  background: var(--jp-primary-soft);
  font-weight: 600;
}

/* --- Badges and Tag Groups --------------------------------------------- */
.jobpilot-tag-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: var(--jp-radius-full);
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--jp-border-subtle);
  background: var(--jp-surface);
  color: var(--jp-text-secondary);
  margin-right: 4px;
  margin-bottom: 4px;
}

.jobpilot-tag-badge[data-type="positive"] {
  background: #f0fdf4;
  border-color: #bbf7d0;
  color: #166534;
}

.jobpilot-tag-badge[data-type="concern"] {
  background: #fffbeb;
  border-color: #fef08a;
  color: #854d0e;
}

.jobpilot-tag-badge[data-type="question"] {
  background: #eff6ff;
  border-color: #bfdbfe;
  color: #1e40af;
}

/* --- Stage pipeline bar ------------------------------------------------ */
.jobpilot-stage-grid {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  margin-bottom: 12px;
  padding-bottom: 4px;
}

.jobpilot-stage-grid::-webkit-scrollbar {
  display: none;
}

.jobpilot-stage-tile,
.jobpilot-stage-tab {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-sm);
  background: var(--jp-surface);
  color: var(--jp-text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.jobpilot-stage-tile:hover,
.jobpilot-stage-tab:hover {
  border-color: var(--jp-primary-border);
  color: var(--jp-text);
}

.jobpilot-stage-tile.jobpilot-stage-tile-active,
.jobpilot-stage-tab[data-active="true"] {
  background: var(--jp-primary-soft);
  border-color: var(--jp-primary-border);
  color: var(--jp-primary);
  font-weight: 600;
}

.jobpilot-stage-name {
  font-size: 11px;
}

.jobpilot-stage-count {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}

.jobpilot-interview-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-top: 6px;
  background: var(--jp-surface-soft);
  border: 1px solid var(--jp-primary-border);
  border-radius: var(--jp-radius-sm);
  font-size: 11px;
  color: var(--jp-primary);
  font-weight: 500;
}

.jobpilot-stage-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* --- Compare Table ----------------------------------------------------- */
.jobpilot-compare-table-wrapper {
  overflow-x: auto;
  margin-top: 10px;
  border: 1px solid var(--jp-border-subtle);
  border-radius: var(--jp-radius-md);
  background: var(--jp-surface);
}

.jobpilot-compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.jobpilot-compare-th, .jobpilot-compare-td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--jp-border-subtle);
  border-right: 1px solid var(--jp-border-subtle);
  vertical-align: top;
}

.jobpilot-compare-th {
  background: var(--jp-surface-soft);
  font-weight: 600;
  color: var(--jp-text-secondary);
  white-space: nowrap;
}

.jobpilot-compare-td:last-child, .jobpilot-compare-th:last-child {
  border-right: none;
}

/* --- Toast -------------------------------------------------------------- */
.jobpilot-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: var(--jp-z-toast);
  max-width: 360px;
  padding: 10px 16px;
  font-family: var(--jp-font);
  font-size: 12px;
  line-height: 1.5;
  color: #ffffff;
  background: #31292c;
  border-radius: var(--jp-radius-md);
  box-shadow: var(--jp-shadow-toast);
  word-break: break-word;
  animation: jobpilot-fadein 0.2s ease;
}

.jobpilot-toast[data-tone="warn"] { background: #8a4e00; }
.jobpilot-toast[data-tone="error"] { background: #b82334; }
.jobpilot-toast[data-tone="success"] { background: #1e6b34; }

@keyframes jobpilot-fadein {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.jobpilot-hidden {
  display: none !important;
}

/* --- Responsive Sizing Adaptations -------------------------------------- */
.jobpilot-root[data-size="compact"] {
  width: 360px;
}

.jobpilot-root[data-size="compact"] .jobpilot-stats-grid {
  grid-template-columns: repeat(2, 1fr);
}

.jobpilot-root[data-size="compact"] .jobpilot-actions {
  flex-wrap: wrap;
}

.jobpilot-root[data-size="compact"] .jobpilot-actions .jobpilot-btn {
  flex: 1 1 45%;
}

.jobpilot-root[data-size="large"] {
  min-width: 600px;
}

.jobpilot-root[data-size="large"] .jobpilot-stats-grid {
  grid-template-columns: repeat(4, 1fr);
}

/* --- Reduced Motion ----------------------------------------------------- */
@media (prefers-reduced-motion: reduce) {
  .jobpilot-root *,
  .jobpilot-launcher,
  .jobpilot-toast {
    transition: none !important;
    animation: none !important;
  }
}
`;
