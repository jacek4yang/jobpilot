/**
 * Writing text into the BOSS message editor.
 *
 * ============================ HONESTY NOTICE ============================
 * The real BOSS chat editor was never inspected. This module is validated only
 * against the synthetic fixtures under `tests/fixtures/boss/`, which contain
 * both a `contenteditable` box and (in one fixture) a `<textarea>`. Whether the
 * live site uses either shape, and whether its framework listens to the events
 * dispatched here, is UNVERIFIED.
 * =======================================================================
 *
 * Why this is not just `editor.value = text`:
 * React/Vue-style frameworks keep their own model of an input's value and only
 * update it from the `input` event. Assigning `.value` directly mutates the DOM
 * without firing that event, so the framework's model stays stale and the
 * eventual submit sends the OLD text. The fix is the standard one: call the
 * prototype's native value setter (which bypasses the framework's own patched
 * setter for that property), then dispatch `input` and `change` so the
 * framework observes the mutation exactly as it would a real keystroke.
 *
 * Safety: this function only ever WRITES TEXT. It never clicks, never focuses,
 * never submits, and never sends. Callers remain responsible for the
 * never-send-twice guard.
 */

import { hasValueProperty, isContentEditable } from "./chat-reader";

/** Outcome of a write attempt. `false` is a normal, non-throwing result. */
export interface WriteResult {
  readonly ok: boolean;
  /** Short, redacted reason when `ok` is false. Never contains the text written. */
  readonly detail: string;
}

/**
 * Resolves the native `value` setter for an element's prototype chain.
 *
 * Failure mode: returns `undefined` when no descriptor can be found (an exotic
 * realm, a detached prototype, a non-form element). Callers then fall back to a
 * plain assignment, which is still correct for static HTML but may not notify a
 * framework — so that fallback path is reported in the result detail.
 */
const nativeValueSetter = (
  element: Element,
): ((this: unknown, value: string) => void) | undefined => {
  let prototype: object | null = Object.getPrototypeOf(element) as object | null;
  let depth = 0;
  while (prototype !== null && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const setter: unknown = descriptor?.set;
    if (typeof setter === "function") {
      return setter as (this: unknown, value: string) => void;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
    depth += 1;
  }
  return undefined;
};

/**
 * Reports whether an element is still attached to a document.
 *
 * Failure mode: `false` for a detached node (or one from a realm that does not
 * expose `isConnected`), which makes the write a no-op instead of a silent
 * write into a node the framework will never see.
 */
const isAttached = (element: Element): boolean => element.isConnected === true;

/**
 * Writes `text` into the editor.
 *
 * Supported shapes:
 *   - `<input>` / `<textarea>`: native value setter + `input` + `change`.
 *   - `contenteditable`: `textContent` replacement, then `input` + `change`,
 *     because those are the events BOSS-like rich editors listen for. This does
 *     NOT reproduce the browser's own contenteditable editing pipeline (no
 *     beforeinput, no ranges), which is a known limitation.
 *
 * Failure modes (all return `{ ok: false }`, none throw):
 *   - the element is not connected to a document;
 *   - the element is neither a value-bearing control nor contenteditable;
 *   - the environment provides no usable `Event` constructor (in which case the
 *     text may still be written but the framework will not be notified, so the
 *     result is reported as a failure rather than a silent half-success);
 *   - `text` is empty, because clearing an editor is not a "prepared message"
 *     and callers must decide that explicitly.
 */
export const writeEditorText = (editor: Element | null, text: string): WriteResult => {
  if (editor === null) return { ok: false, detail: "editor-missing" };
  if (!isAttached(editor)) return { ok: false, detail: "editor-detached" };
  if (text.length === 0) return { ok: false, detail: "empty-text" };

  const dispatch = (type: "input" | "change"): boolean => {
    try {
      const view = editor.ownerDocument.defaultView;
      if (view === null) return false;
      editor.dispatchEvent(new view.Event(type, { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  if (hasValueProperty(editor)) {
    const setter = nativeValueSetter(editor);
    try {
      if (setter === undefined) {
        (editor as unknown as { value: string }).value = text;
      } else {
        setter.call(editor, text);
      }
    } catch {
      return { ok: false, detail: "value-assignment-threw" };
    }
    const notified = dispatch("input") && dispatch("change");
    return notified
      ? {
          ok: true,
          detail:
            setter === undefined ? "written-via-plain-assignment" : "written-via-native-setter",
        }
      : { ok: false, detail: "value-written-but-event-dispatch-unavailable" };
  }

  if (isContentEditable(editor)) {
    try {
      editor.textContent = text;
    } catch {
      return { ok: false, detail: "textContent-assignment-threw" };
    }
    const notified = dispatch("input") && dispatch("change");
    return notified
      ? { ok: true, detail: "written-via-textContent" }
      : { ok: false, detail: "textContent-written-but-event-dispatch-unavailable" };
  }

  return { ok: false, detail: "editor-is-neither-value-control-nor-contenteditable" };
};
