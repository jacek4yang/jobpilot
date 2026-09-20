/**
 * JobPilot design tokens and scoped stylesheet.
 *
 * Everything is scoped under `.jobpilot-root` and the panel sets `all: initial`
 * on that root, so the host page's typography and resets cannot leak in and
 * JobPilot's rules cannot leak out.
 *
 * The palette is deliberately restrained: JobPilot should read as a tool that
 * belongs to the page, not as an alert demanding attention. Only safety states
 * (blocked, uncertain) use saturated colour.
 */

export const TOKENS = {
  font: `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`,
  mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  radius: "8px",
  radiusSm: "5px",
} as const;

export const PANEL_CSS = `
.jobpilot-root {
  all: initial;
  position: fixed;
  top: 84px;
  right: 20px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  width: 380px;
  max-height: min(640px, calc(100vh - 120px));
  font-family: ${TOKENS.font};
  font-size: 12px;
  line-height: 1.5;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d8dee4;
  border-radius: ${TOKENS.radius};
  box-shadow: 0 10px 32px rgba(15, 23, 42, 0.16), 0 1px 3px rgba(15, 23, 42, 0.08);
  overflow: hidden;
  font-variant-numeric: tabular-nums;
}

.jobpilot-root *, .jobpilot-root *::before, .jobpilot-root *::after {
  box-sizing: border-box;
}

/* --- Launcher ----------------------------------------------------------- */
.jobpilot-launcher {
  position: fixed;
  top: 84px;
  right: 20px;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  font-family: ${TOKENS.font};
  font-size: 12px;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d8dee4;
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14);
  cursor: pointer;
  user-select: none;
}
.jobpilot-launcher:hover { background: #f6f8fa; }
.jobpilot-launcher-monogram { font-weight: 700; letter-spacing: 0.02em; }
.jobpilot-launcher-count { color: #57606a; }

.jobpilot-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #8c959f; flex: none;
}
.jobpilot-dot[data-state="idle"] { background: #8c959f; }
.jobpilot-dot[data-state="scanning"],
.jobpilot-dot[data-state="evaluating"],
.jobpilot-dot[data-state="opening"],
.jobpilot-dot[data-state="validating"],
.jobpilot-dot[data-state="applying"],
.jobpilot-dot[data-state="verifying"],
.jobpilot-dot[data-state="cooldown"],
.jobpilot-dot[data-state="discovering"],
.jobpilot-dot[data-state="executing"] { background: #0969da; }
.jobpilot-dot[data-state="paused"],
.jobpilot-dot[data-state="reviewing"] { background: #bf8700; }
.jobpilot-dot[data-state="blocked"],
.jobpilot-dot[data-state="failed"] { background: #cf222e; }

/* --- Header ------------------------------------------------------------- */
.jobpilot-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: #f6f8fa;
  border-bottom: 1px solid #d8dee4;
  cursor: pointer;
  user-select: none;
  flex: none;
}
.jobpilot-title { font-size: 13px; font-weight: 700; flex: 1; }
.jobpilot-mode-chip, .jobpilot-safety-chip, .jobpilot-page-chip {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: #eaeef2;
  color: #57606a;
  white-space: nowrap;
}
.jobpilot-safety-chip[data-safety="auto"] { background: #fff1c1; color: #7d4e00; }
.jobpilot-safety-chip[data-safety="blocked"] { background: #ffebe9; color: #a40e26; }
.jobpilot-safety-chip[data-safety="paused"] { background: #fff1c1; color: #7d4e00; }
.jobpilot-safety-chip[data-safety="safe"] { background: #dafbe1; color: #116329; }
.jobpilot-page-chip { background: #ddf4ff; color: #0a3069; }

/* --- Tabs --------------------------------------------------------------- */
.jobpilot-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 8px 0;
  background: #ffffff;
  border-bottom: 1px solid #d8dee4;
  flex: none;
}
.jobpilot-tab {
  padding: 5px 9px;
  font: inherit;
  font-weight: 500;
  color: #57606a;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: ${TOKENS.radiusSm} ${TOKENS.radiusSm} 0 0;
  cursor: pointer;
}
.jobpilot-tab:hover { color: #1f2328; background: #f6f8fa; }
.jobpilot-tab[aria-selected="true"] {
  color: #0969da;
  border-bottom-color: #0969da;
  font-weight: 600;
}

/* --- Body --------------------------------------------------------------- */
.jobpilot-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.jobpilot-panel { display: none; padding: 12px; }
.jobpilot-panel[data-active="true"] { display: block; }

.jobpilot-section { margin-bottom: 14px; }
.jobpilot-section:last-child { margin-bottom: 0; }
.jobpilot-section-title {
  display: block;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #57606a;
}

/* --- Current item ------------------------------------------------------- */
.jobpilot-current {
  padding: 9px 10px;
  border: 1px solid #d8dee4;
  border-radius: ${TOKENS.radiusSm};
  background: #f6f8fa;
}
.jobpilot-current-title { font-weight: 600; word-break: break-word; }
.jobpilot-current-meta { color: #57606a; }
.jobpilot-phase {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #d8dee4;
  font-size: 11px;
  color: #57606a;
}

/* --- Stats -------------------------------------------------------------- */
.jobpilot-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.jobpilot-stat {
  padding: 6px 8px;
  border: 1px solid #d8dee4;
  border-radius: ${TOKENS.radiusSm};
  background: #ffffff;
}
.jobpilot-stat-label {
  display: block;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #57606a;
}
.jobpilot-stat-value { display: block; font-size: 15px; font-weight: 600; }

/* --- Messages ----------------------------------------------------------- */
.jobpilot-message {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: ${TOKENS.radiusSm};
  background: #f6f8fa;
  border-left: 3px solid #0969da;
  word-break: break-word;
}
.jobpilot-message[data-tone="warn"] { border-left-color: #bf8700; background: #fff8c5; }
.jobpilot-message[data-tone="error"] { border-left-color: #cf222e; background: #ffebe9; }
.jobpilot-message[data-tone="success"] { border-left-color: #1f883d; background: #dafbe1; }

/* --- Blocked panel ------------------------------------------------------ */
.jobpilot-blocked { padding: 14px 12px; }
.jobpilot-blocked-reason {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: #a40e26;
  word-break: break-word;
}
.jobpilot-blocked-body { margin: 0 0 12px; color: #57606a; }

/* --- Lists -------------------------------------------------------------- */
.jobpilot-list { list-style: none; margin: 0; padding: 0; }
.jobpilot-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid #eaeef2;
}
.jobpilot-row:last-child { border-bottom: none; }
.jobpilot-row-main { flex: 1; min-width: 0; }
.jobpilot-row-title { font-weight: 600; word-break: break-word; }
.jobpilot-row-meta { color: #57606a; font-size: 11px; word-break: break-word; }
.jobpilot-row-reasons {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  color: #57606a;
}
.jobpilot-reason { display: block; }
.jobpilot-reason[data-sign="plus"] { color: #116329; }
.jobpilot-reason[data-sign="minus"] { color: #a40e26; }

.jobpilot-score {
  flex: none;
  min-width: 30px;
  padding: 2px 6px;
  border-radius: ${TOKENS.radiusSm};
  background: #eaeef2;
  font-weight: 700;
  text-align: center;
}
.jobpilot-score[data-band="high"] { background: #dafbe1; color: #116329; }
.jobpilot-score[data-band="low"] { background: #f6f8fa; color: #57606a; }

.jobpilot-status-chip {
  display: inline-block;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: #eaeef2;
  color: #57606a;
}
.jobpilot-status-chip[data-status="completed"] { background: #dafbe1; color: #116329; }
.jobpilot-status-chip[data-status="blocked"],
.jobpilot-status-chip[data-status="uncertain"] { background: #ffebe9; color: #a40e26; }
.jobpilot-status-chip[data-status="running"] { background: #ddf4ff; color: #0a3069; }

/* --- Controls ----------------------------------------------------------- */
.jobpilot-actions {
  display: flex;
  gap: 6px;
  padding: 9px 12px;
  background: #f6f8fa;
  border-top: 1px solid #d8dee4;
  flex: none;
}
.jobpilot-btn {
  flex: 1;
  padding: 6px 9px;
  font: inherit;
  font-weight: 600;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d8dee4;
  border-radius: ${TOKENS.radiusSm};
  cursor: pointer;
}
.jobpilot-btn:hover:not(:disabled) { background: #f3f4f6; }
.jobpilot-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.jobpilot-btn[data-variant="primary"] { background: #1f883d; border-color: #1f883d; color: #fff; }
.jobpilot-btn[data-variant="primary"]:hover:not(:disabled) { background: #1a7f37; }
.jobpilot-btn[data-variant="danger"] { background: #cf222e; border-color: #cf222e; color: #fff; }
.jobpilot-btn[data-variant="danger"]:hover:not(:disabled) { background: #a40e26; }
.jobpilot-btn[data-variant="subtle"] { background: transparent; border-color: transparent; color: #0969da; }

.jobpilot-checkbox-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
}
.jobpilot-checkbox { flex: none; margin: 0; }

/* --- Fields ------------------------------------------------------------- */
.jobpilot-field { display: block; margin-bottom: 9px; }
.jobpilot-field-label { display: block; font-weight: 600; margin-bottom: 3px; }
.jobpilot-input, .jobpilot-select, .jobpilot-textarea {
  width: 100%;
  padding: 5px 7px;
  font: inherit;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d8dee4;
  border-radius: ${TOKENS.radiusSm};
}
.jobpilot-textarea {
  min-height: 64px;
  resize: vertical;
  font-family: ${TOKENS.mono};
  font-size: 11px;
}
.jobpilot-hint { color: #57606a; font-size: 11px; }
.jobpilot-mono { font-family: ${TOKENS.mono}; font-size: 11px; word-break: break-all; }

/* --- Logs --------------------------------------------------------------- */
.jobpilot-log { margin: 0; padding: 0; list-style: none; }
.jobpilot-log-item {
  padding: 4px 0;
  border-bottom: 1px solid #eaeef2;
  word-break: break-word;
}
.jobpilot-log-item:last-child { border-bottom: none; }
.jobpilot-log-level {
  font-weight: 700;
  font-size: 10px;
  text-transform: uppercase;
  margin-right: 5px;
}
.jobpilot-log-item[data-level="debug"] .jobpilot-log-level { color: #8c959f; }
.jobpilot-log-item[data-level="info"] .jobpilot-log-level { color: #0969da; }
.jobpilot-log-item[data-level="warn"] .jobpilot-log-level { color: #bf8700; }
.jobpilot-log-item[data-level="error"] .jobpilot-log-level { color: #cf222e; }

.jobpilot-disclosure > summary {
  cursor: pointer;
  font-weight: 600;
  color: #57606a;
  padding: 4px 0;
}

/* --- Toast -------------------------------------------------------------- */
.jobpilot-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483001;
  max-width: 320px;
  padding: 9px 11px;
  font-family: ${TOKENS.font};
  font-size: 12px;
  line-height: 1.5;
  color: #ffffff;
  background: #24292f;
  border-radius: ${TOKENS.radiusSm};
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.28);
  word-break: break-word;
}
.jobpilot-toast[data-tone="warn"] { background: #9a6700; }
.jobpilot-toast[data-tone="error"] { background: #a40e26; }
.jobpilot-toast[data-tone="success"] { background: #1a7f37; }

.jobpilot-hidden { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  .jobpilot-root *, .jobpilot-launcher, .jobpilot-toast { transition: none !important; }
}
`;
