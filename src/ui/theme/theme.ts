/**
 * CSS Variables generator and theme injection.
 */

import { TOKENS } from "./tokens";

export const THEME_VARIABLES = `
  --jp-font: ${TOKENS.fontFamily};
  --jp-font-mono: ${TOKENS.monoFont};

  --jp-bg: ${TOKENS.colors.bg};
  --jp-surface: ${TOKENS.colors.surface};
  --jp-surface-soft: ${TOKENS.colors.surfaceSoft};
  --jp-surface-secondary: ${TOKENS.colors.surfaceSecondary};
  --jp-surface-hover: ${TOKENS.colors.surfaceHover};

  --jp-primary: ${TOKENS.colors.primary};
  --jp-primary-hover: ${TOKENS.colors.primaryHover};
  --jp-primary-active: ${TOKENS.colors.primaryActive};
  --jp-primary-soft: ${TOKENS.colors.primarySoft};
  --jp-primary-border: ${TOKENS.colors.primaryBorder};

  --jp-border: ${TOKENS.colors.border};
  --jp-border-subtle: ${TOKENS.colors.borderSubtle};
  --jp-border-focus: ${TOKENS.colors.borderFocus};

  --jp-text: ${TOKENS.colors.text};
  --jp-text-secondary: ${TOKENS.colors.textSecondary};
  --jp-text-muted: ${TOKENS.colors.textMuted};

  --jp-success: ${TOKENS.colors.success};
  --jp-success-bg: ${TOKENS.colors.successBg};
  --jp-success-border: ${TOKENS.colors.successBorder};

  --jp-warning: ${TOKENS.colors.warning};
  --jp-warning-bg: ${TOKENS.colors.warningBg};
  --jp-warning-border: ${TOKENS.colors.warningBorder};

  --jp-danger: ${TOKENS.colors.danger};
  --jp-danger-bg: ${TOKENS.colors.dangerBg};
  --jp-danger-border: ${TOKENS.colors.dangerBorder};

  --jp-chip-safe-bg: ${TOKENS.colors.chipSafeBg};
  --jp-chip-safe-text: ${TOKENS.colors.chipSafeText};
  --jp-chip-paused-bg: ${TOKENS.colors.chipPausedBg};
  --jp-chip-paused-text: ${TOKENS.colors.chipPausedText};
  --jp-chip-blocked-bg: ${TOKENS.colors.chipBlockedBg};
  --jp-chip-blocked-text: ${TOKENS.colors.chipBlockedText};
  --jp-chip-auto-bg: ${TOKENS.colors.chipAutoBg};
  --jp-chip-auto-text: ${TOKENS.colors.chipAutoText};
  --jp-chip-page-bg: ${TOKENS.colors.chipPageBg};
  --jp-chip-page-text: ${TOKENS.colors.chipPageText};

  --jp-radius-xs: ${TOKENS.radius.xs};
  --jp-radius-sm: ${TOKENS.radius.sm};
  --jp-radius-md: ${TOKENS.radius.md};
  --jp-radius-lg: ${TOKENS.radius.lg};
  --jp-radius-full: ${TOKENS.radius.full};

  --jp-shadow-panel: ${TOKENS.shadows.panel};
  --jp-shadow-launcher: ${TOKENS.shadows.launcher};
  --jp-shadow-card: ${TOKENS.shadows.card};
  --jp-shadow-toast: ${TOKENS.shadows.toast};

  --jp-z-panel: ${TOKENS.zIndex.panel};
  --jp-z-toast: ${TOKENS.zIndex.toast};
`;
