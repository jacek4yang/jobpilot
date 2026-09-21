/**
 * Panel geometry, constraints, and clamping algorithms.
 */

import type { PanelPosition } from "../../config/schema";

export interface PanelGeometry {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly collapsed: boolean;
}

export interface StoredGeometryInput {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly position?: PanelPosition | undefined;
  readonly collapsed?: boolean | undefined;
}

export const GEOMETRY_LIMITS = {
  MIN_WIDTH: 340,
  DEFAULT_WIDTH: 480,
  MAX_WIDTH_CAP: 880,
  MIN_HEIGHT: 400,
  DEFAULT_HEIGHT: 640,
  MAX_HEIGHT_CAP: 1200,
  VIEWPORT_MARGIN: 16,
  DEFAULT_TOP: 84,
  DEFAULT_RIGHT_MARGIN: 20,
} as const;

export type SizeCategory = "compact" | "normal" | "large";

export const getSizeCategory = (width: number): SizeCategory => {
  if (width < 420) return "compact";
  if (width > 580) return "large";
  return "normal";
};

export interface ViewportDimensions {
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/**
 * Clamps panel geometry ensuring it never escapes the visible viewport,
 * never exceeds maximum bounds, and always respects minimum ergonomics.
 */
export const clampGeometry = (
  stored: StoredGeometryInput | undefined,
  viewport: ViewportDimensions,
): PanelGeometry => {
  const margin = GEOMETRY_LIMITS.VIEWPORT_MARGIN;
  const vw = Math.max(320, viewport.innerWidth);
  const vh = Math.max(320, viewport.innerHeight);

  const maxWidth = Math.max(
    GEOMETRY_LIMITS.MIN_WIDTH,
    Math.min(GEOMETRY_LIMITS.MAX_WIDTH_CAP, vw - margin * 2),
  );
  const maxHeight = Math.max(
    GEOMETRY_LIMITS.MIN_HEIGHT,
    Math.min(GEOMETRY_LIMITS.MAX_HEIGHT_CAP, vh - margin * 2),
  );

  let width = stored?.width ?? GEOMETRY_LIMITS.DEFAULT_WIDTH;
  if (!Number.isFinite(width)) width = GEOMETRY_LIMITS.DEFAULT_WIDTH;
  width = Math.min(maxWidth, Math.max(GEOMETRY_LIMITS.MIN_WIDTH, width));

  let height = stored?.height ?? GEOMETRY_LIMITS.DEFAULT_HEIGHT;
  if (!Number.isFinite(height)) height = GEOMETRY_LIMITS.DEFAULT_HEIGHT;
  height = Math.min(maxHeight, Math.max(GEOMETRY_LIMITS.MIN_HEIGHT, height));

  // Determine X & Y
  let x: number;
  let y: number;

  const pos = stored?.position;
  if (typeof pos === "object" && pos !== null && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    x = pos.x;
    y = pos.y;
  } else if (pos === "top-left") {
    x = margin;
    y = GEOMETRY_LIMITS.DEFAULT_TOP;
  } else if (pos === "bottom-left") {
    x = margin;
    y = Math.max(margin, vh - height - margin);
  } else if (pos === "bottom-right") {
    x = Math.max(margin, vw - width - GEOMETRY_LIMITS.DEFAULT_RIGHT_MARGIN);
    y = Math.max(margin, vh - height - margin);
  } else {
    // Default top-right anchor
    x = Math.max(margin, vw - width - GEOMETRY_LIMITS.DEFAULT_RIGHT_MARGIN);
    y = Math.min(GEOMETRY_LIMITS.DEFAULT_TOP, Math.max(margin, vh - height - margin));
  }

  // Safety clamp to ensure 100% within visible viewport
  const maxX = Math.max(margin, vw - width - margin);
  const maxY = Math.max(margin, vh - height - margin);

  x = Math.max(margin, Math.min(maxX, x));
  y = Math.max(margin, Math.min(maxY, y));

  return {
    width,
    height,
    x,
    y,
    collapsed: stored?.collapsed === true,
  };
};
