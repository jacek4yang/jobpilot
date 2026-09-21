/**
 * Dynamic resizing controller with multi-handle support.
 *
 * Supports:
 * - East handle (width)
 * - West handle (width from left)
 * - South handle (height)
 * - South-East handle (width & height)
 * - South-West handle (width & height from left)
 */

import { GEOMETRY_LIMITS, getSizeCategory } from "./geometry";

export interface ResizeOptions {
  readonly target: HTMLElement;
  readonly doc: Document;
  readonly onResizeChange: (size: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  }) => void;
  readonly onResizeEnd: (size: { width: number; height: number; x?: number; y?: number }) => void;
}

export const createResizeController = (options: ResizeOptions): { dispose: () => void } => {
  const { target, doc, onResizeChange, onResizeEnd } = options;

  const handles: Array<{ element: HTMLElement; direction: string }> = [];

  const addHandle = (dir: string, className: string): HTMLElement => {
    const el = doc.createElement("div");
    el.className = `jobpilot-resize-handle ${className}`;
    el.setAttribute("data-resize-handle", dir);
    target.append(el);
    handles.push({ element: el, direction: dir });
    return el;
  };

  addHandle("e", "jobpilot-resize-e");
  addHandle("w", "jobpilot-resize-w");
  addHandle("s", "jobpilot-resize-s");
  addHandle("se", "jobpilot-resize-se");
  addHandle("sw", "jobpilot-resize-sw");

  // Visual indicator in bottom right corner
  const indicator = doc.createElement("div");
  indicator.className = "jobpilot-resize-indicator";
  target.append(indicator);

  let activeDirection: string | null = null;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let startLeft = 0;
  let startTop = 0;

  const onPointerDown = (event: PointerEvent, direction: string): void => {
    if (event.button !== 0) return;
    activeDirection = direction;
    startX = event.clientX;
    startY = event.clientY;

    const rect = target.getBoundingClientRect();
    startWidth = rect.width;
    startHeight = rect.height;
    startLeft = rect.left;
    startTop = rect.top;

    target.style.userSelect = "none";
    target.style.transition = "none";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!activeDirection) return;

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    const margin = GEOMETRY_LIMITS.VIEWPORT_MARGIN;
    const maxWidth = Math.min(GEOMETRY_LIMITS.MAX_WIDTH_CAP, window.innerWidth - margin * 2);
    const maxHeight = Math.min(GEOMETRY_LIMITS.MAX_HEIGHT_CAP, window.innerHeight - margin * 2);

    let nextWidth = startWidth;
    let nextHeight = startHeight;
    let nextLeft = startLeft;

    if (activeDirection.includes("e")) {
      nextWidth = Math.max(GEOMETRY_LIMITS.MIN_WIDTH, Math.min(maxWidth, startWidth + deltaX));
    } else if (activeDirection.includes("w")) {
      const prospectiveWidth = startWidth - deltaX;
      nextWidth = Math.max(GEOMETRY_LIMITS.MIN_WIDTH, Math.min(maxWidth, prospectiveWidth));
      nextLeft = startLeft + (startWidth - nextWidth);
      nextLeft = Math.max(margin, nextLeft);
    }

    if (activeDirection.includes("s")) {
      nextHeight = Math.max(GEOMETRY_LIMITS.MIN_HEIGHT, Math.min(maxHeight, startHeight + deltaY));
    }

    target.style.width = `${Math.round(nextWidth)}px`;
    target.style.height = `${Math.round(nextHeight)}px`;
    target.setAttribute("data-size", getSizeCategory(nextWidth));

    if (activeDirection.includes("w")) {
      target.style.left = `${Math.round(nextLeft)}px`;
      target.style.right = "auto";
    }

    onResizeChange({
      width: Math.round(nextWidth),
      height: Math.round(nextHeight),
      x: Math.round(nextLeft),
      y: Math.round(startTop),
    });
  };

  const onPointerUp = (): void => {
    if (!activeDirection) return;
    activeDirection = null;

    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);

    target.style.userSelect = "";
    target.style.transition = "";

    const rect = target.getBoundingClientRect();
    onResizeEnd({
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
    });
  };

  const listeners: Array<() => void> = [];

  for (const { element, direction } of handles) {
    const handler = (event: PointerEvent) => onPointerDown(event, direction);
    element.addEventListener("pointerdown", handler);
    listeners.push(() => element.removeEventListener("pointerdown", handler));
  }

  return {
    dispose: () => {
      for (const remove of listeners) remove();
      for (const { element } of handles) element.remove();
      indicator.remove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    },
  };
};
