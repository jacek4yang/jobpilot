/**
 * Scoped stylesheet for the JobPilot control panel.
 *
 * Injected as a single <style> element and scoped by the `jobpilot-` class
 * prefix on every rule. The host page's global styles are never touched, and
 * the panel sets its own `all: initial`-style resets on the root so inherited
 * page typography cannot leak in.
 */
export const PANEL_CSS = `
.jobpilot-root {
  all: initial;
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483000;
  width: 340px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.5;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.jobpilot-root[data-collapsed="true"] .jobpilot-body { display: none; }

.jobpilot-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #24292f;
  color: #ffffff;
  cursor: pointer;
  user-select: none;
}

.jobpilot-title { font-weight: 600; font-size: 13px; flex: 1; }

.jobpilot-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: #57606a;
  color: #ffffff;
}
.jobpilot-badge[data-state="idle"] { background: #57606a; }
.jobpilot-badge[data-state="scanning"],
.jobpilot-badge[data-state="evaluating"],
.jobpilot-badge[data-state="opening"],
.jobpilot-badge[data-state="validating"],
.jobpilot-badge[data-state="applying"],
.jobpilot-badge[data-state="verifying"],
.jobpilot-badge[data-state="cooldown"] { background: #0969da; }
.jobpilot-badge[data-state="paused"] { background: #bf8700; }
.jobpilot-badge[data-state="blocked"] { background: #cf222e; }
.jobpilot-badge[data-state="failed"] { background: #cf222e; }

.jobpilot-body { display: flex; flex-direction: column; min-height: 0; }

.jobpilot-tabs {
  display: flex;
  border-bottom: 1px solid #d0d7de;
  background: #f6f8fa;
  flex-wrap: wrap;
}

.jobpilot-tab {
  flex: 1 0 auto;
  padding: 6px 8px;
  border: none;
  background: transparent;
  font: inherit;
  color: #57606a;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.jobpilot-tab[aria-selected="true"] {
  color: #0969da;
  border-bottom-color: #0969da;
  font-weight: 600;
}

.jobpilot-panel { display: none; padding: 10px; overflow-y: auto; max-height: 340px; }
.jobpilot-panel[data-active="true"] { display: block; }

.jobpilot-actions {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid #d0d7de;
  background: #f6f8fa;
}

.jobpilot-btn {
  flex: 1;
  padding: 6px 8px;
  font: inherit;
  font-weight: 600;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #ffffff;
  color: #24292f;
  cursor: pointer;
}
.jobpilot-btn:hover:not(:disabled) { background: #f3f4f6; }
.jobpilot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.jobpilot-btn[data-variant="primary"] { background: #1f883d; border-color: #1f883d; color: #ffffff; }
.jobpilot-btn[data-variant="danger"] { background: #cf222e; border-color: #cf222e; color: #ffffff; }

.jobpilot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.jobpilot-stat {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 6px 8px;
  background: #f6f8fa;
}
.jobpilot-stat-label { display: block; color: #57606a; font-size: 10px; text-transform: uppercase; }
.jobpilot-stat-value { display: block; font-size: 16px; font-weight: 600; }

.jobpilot-message {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #f6f8fa;
  border-left: 3px solid #0969da;
  word-break: break-word;
}
.jobpilot-message[data-level="warn"] { border-left-color: #bf8700; background: #fff8c5; }
.jobpilot-message[data-level="error"] { border-left-color: #cf222e; background: #ffebe9; }

.jobpilot-list { list-style: none; margin: 0; padding: 0; }
.jobpilot-list-item {
  padding: 6px 0;
  border-bottom: 1px solid #eaeef2;
  word-break: break-word;
}
.jobpilot-list-item:last-child { border-bottom: none; }
.jobpilot-muted { color: #57606a; }
.jobpilot-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }

.jobpilot-field { display: block; margin-bottom: 8px; }
.jobpilot-field-label { display: block; font-weight: 600; margin-bottom: 2px; }
.jobpilot-input, .jobpilot-select, .jobpilot-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
  font: inherit;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #ffffff;
  color: #1f2328;
}
.jobpilot-textarea { min-height: 60px; resize: vertical; font-family: ui-monospace, Menlo, Consolas, monospace; }
.jobpilot-hint { color: #57606a; font-size: 10px; }

.jobpilot-log { margin: 0; padding: 0; list-style: none; }
.jobpilot-log-item { padding: 3px 0; border-bottom: 1px solid #eaeef2; word-break: break-word; }
.jobpilot-log-level { font-weight: 600; text-transform: uppercase; font-size: 10px; margin-right: 4px; }
.jobpilot-log-item[data-level="debug"] .jobpilot-log-level { color: #57606a; }
.jobpilot-log-item[data-level="info"] .jobpilot-log-level { color: #0969da; }
.jobpilot-log-item[data-level="warn"] .jobpilot-log-level { color: #bf8700; }
.jobpilot-log-item[data-level="error"] .jobpilot-log-level { color: #cf222e; }

.jobpilot-toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2147483001;
  max-width: 320px;
  padding: 8px 10px;
  border-radius: 6px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  font-size: 12px;
  background: #24292f;
  color: #ffffff;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
}
.jobpilot-toast[data-level="warn"] { background: #bf8700; }
.jobpilot-toast[data-level="error"] { background: #cf222e; }
`;
