/**
 * Centralized design tokens for JobPilot's warm pink & calm UI theme.
 *
 * Designed to provide a gentle, reassuring, and trustworthy experience for
 * Chinese job seekers while maintaining professional polish and high contrast.
 */

export const TOKENS = {
  fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`,
  monoFont: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,

  colors: {
    // Backgrounds & Surfaces
    bg: "#faf7f8",
    surface: "#ffffff",
    surfaceSoft: "#fff8f9",
    surfaceSecondary: "#fcf4f6",
    surfaceHover: "#f8edf0",

    // Primary Rose Pink
    primary: "#cf5477",
    primaryHover: "#b84264",
    primaryActive: "#a23654",
    primarySoft: "#fdeef2",
    primaryBorder: "#f7cbd6",

    // Borders
    border: "#ebd7de",
    borderSubtle: "#f4e7ec",
    borderFocus: "#cf5477",

    // Typography
    text: "#2c2427",
    textSecondary: "#716469",
    textMuted: "#9a8c92",

    // State Colors
    success: "#267a3d",
    successBg: "#edf7ef",
    successBorder: "#c6e7ce",

    warning: "#965500",
    warningBg: "#fdf6e6",
    warningBorder: "#f8dea4",

    danger: "#c42738",
    dangerBg: "#fdeeed",
    dangerBorder: "#f8c7cc",

    // Safety and Mode Chips
    chipSafeBg: "#edf7ef",
    chipSafeText: "#1b612e",
    chipPausedBg: "#fdf6e6",
    chipPausedText: "#7d4600",
    chipBlockedBg: "#fdeeed",
    chipBlockedText: "#a31828",
    chipAutoBg: "#fff2e0",
    chipAutoText: "#965500",
    chipPageBg: "#f5eff5",
    chipPageText: "#6d3a6d",
  },

  radius: {
    xs: "4px",
    sm: "6px",
    md: "10px",
    lg: "14px",
    full: "9999px",
  },

  spacing: {
    xxs: "2px",
    xs: "4px",
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "20px",
    xxl: "24px",
  },

  fontSize: {
    xs: "11px",
    sm: "12px",
    md: "13px",
    lg: "14px",
    xl: "16px",
    title: "18px",
  },

  shadows: {
    panel: "0 10px 36px rgba(160, 90, 115, 0.14), 0 2px 8px rgba(0, 0, 0, 0.04)",
    launcher: "0 4px 18px rgba(160, 90, 115, 0.15), 0 1px 3px rgba(0, 0, 0, 0.05)",
    card: "0 2px 6px rgba(160, 90, 115, 0.05)",
    toast: "0 8px 24px rgba(44, 36, 39, 0.18)",
  },

  zIndex: {
    panel: 2147483000,
    toast: 2147483001,
  },
} as const;
