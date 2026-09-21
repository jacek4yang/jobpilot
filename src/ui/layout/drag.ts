/**
 * Safe draggable header controller.
 *
 * Requirements:
 * - No dragging while selecting text or clicking interactive elements
 * - No dragging off-screen
 * - Clamps to viewport
 * - Reports final position to caller for persistence
 */

export interface DragOptions {
  readonly handle: HTMLElement;
  readonly target: HTMLElement;
  readonly getBounds: () => { width: number; height: number };
  readonly onPositionChange: (pos: { x: number; y: number }) => void;
  readonly onDragEnd: (pos: { x: number; y: number }) => void;
}

export const createDragController = (options: DragOptions): { dispose: () => void } => {
  const { handle, target, getBounds, onPositionChange, onDragEnd } = options;

  let isDragging = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let startElementX = 0;
  let startElementY = 0;

  const isInteractive = (el: EventTarget | null): boolean => {
    if (!(el instanceof Element)) return false;
    const tag = el.tagName.toUpperCase();
    if (
      tag === "BUTTON" ||
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "A"
    ) {
      return true;
    }
    if (el.getAttribute("role") === "button" || el.getAttribute("role") === "tab") {
      return true;
    }
    return el.closest("button, input, select, textarea, [role='button']") !== null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return; // primary click only
    if (isInteractive(event.target)) return;

    isDragging = true;
    startMouseX = event.clientX;
    startMouseY = event.clientY;

    const rect = target.getBoundingClientRect();
    startElementX = rect.left;
    startElementY = rect.top;

    target.style.userSelect = "none";
    target.style.transition = "none";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!isDragging) return;

    const deltaX = event.clientX - startMouseX;
    const deltaY = event.clientY - startMouseY;

    const { width, height } = getBounds();
    const margin = 16;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

    let nextX = startElementX + deltaX;
    let nextY = startElementY + deltaY;

    nextX = Math.max(margin, Math.min(maxX, nextX));
    nextY = Math.max(margin, Math.min(maxY, nextY));

    target.style.left = `${Math.round(nextX)}px`;
    target.style.top = `${Math.round(nextY)}px`;
    target.style.right = "auto";
    target.style.bottom = "auto";

    onPositionChange({ x: Math.round(nextX), y: Math.round(nextY) });
  };

  const onPointerUp = (): void => {
    if (!isDragging) return;
    isDragging = false;

    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);

    target.style.userSelect = "";
    target.style.transition = "";

    const rect = target.getBoundingClientRect();
    onDragEnd({ x: Math.round(rect.left), y: Math.round(rect.top) });
  };

  handle.addEventListener("pointerdown", onPointerDown);

  return {
    dispose: () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    },
  };
};
