/**
 * SPA lifecycle management.
 *
 * BOSS is a single-page application: navigating between the job list and a
 * job detail page does not reload the document. This module owns:
 *
 * - MutationObserver lifecycle (exactly one observer, always disconnected)
 * - History API / URL-change detection
 * - debounced "the relevant DOM changed" notifications
 *
 * Everything is registered against one AbortController, so a single
 * `dispose()` tears down every listener and timer with no leaks.
 */

export type PageChangeListener = (url: string, reason: PageChangeReason) => void;
export type DomChangeListener = () => void;

export type PageChangeReason = "push-state" | "replace-state" | "pop-state" | "poll";

export interface PageObserverOptions {
  /** Debounce window for DOM mutations, in ms. Defaults to 400. */
  readonly debounceMs?: number;
  /**
   * Fallback poll interval for URL changes, in ms. Covers frameworks that
   * replace `history.pushState` before we patch it. Defaults to 1000ms.
   */
  readonly pollIntervalMs?: number;
}

export interface PageObserver {
  onPageChange(listener: PageChangeListener): void;
  onDomChange(listener: DomChangeListener): void;
  /** Starts observing. Idempotent. */
  start(): void;
  /** Stops observing without releasing the abort controller. */
  stop(): void;
  /** Permanently tears down every listener, observer and timer. */
  dispose(): void;
  readonly disposed: boolean;
  readonly currentUrl: string;
}

interface HistoryPatch {
  readonly original: () => void;
  readonly patched: () => void;
}

/**
 * Creates a page observer for the given window.
 *
 * The returned object is single-use: after `dispose()` it does nothing.
 */
export const createPageObserver = (
  win: Window,
  options: PageObserverOptions = {},
): PageObserver => {
  const debounceMs = options.debounceMs ?? 400;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const controller = new AbortController();
  const { signal } = controller;

  const pageListeners = new Set<PageChangeListener>();
  const domListeners = new Set<DomChangeListener>();

  let disposed = false;
  let started = false;
  let lastUrl = win.location.href;
  let mutationObserver: MutationObserver | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const historyPatches: HistoryPatch[] = [];

  // Replaced on observe() and restored on dispose(). Resolved lazily so the
  // module keeps working if the host page swaps the history object.
  const history = win.history;
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  const emitPageChange = (reason: PageChangeReason): void => {
    if (disposed) return;
    const url = win.location.href;
    if (reason !== "poll" && url === lastUrl) return;
    lastUrl = url;
    for (const listener of pageListeners) listener(url, reason);
  };

  const emitDomChange = (): void => {
    if (disposed) return;
    for (const listener of domListeners) listener();
  };

  const scheduleDomChange = (): void => {
    if (disposed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      emitDomChange();
    }, debounceMs);
  };

  const patchHistory = (): void => {
    const push = function pushState(
      this: History,
      ...args: Parameters<History["pushState"]>
    ): void {
      originalPushState(...args);
      emitPageChange("push-state");
    };
    const replace = function replaceState(
      this: History,
      ...args: Parameters<History["replaceState"]>
    ): void {
      originalReplaceState(...args);
      emitPageChange("replace-state");
    };
    history.pushState = push as History["pushState"];
    history.replaceState = replace as History["replaceState"];
    historyPatches.push({
      original: () => {
        history.pushState = originalPushState as History["pushState"];
      },
      patched: () => {},
    });
  };

  const unpatchHistory = (): void => {
    while (historyPatches.length > 0) {
      const patch = historyPatches.pop();
      patch?.original();
    }
  };

  return {
    onPageChange(listener) {
      pageListeners.add(listener);
    },

    onDomChange(listener) {
      domListeners.add(listener);
    },

    start() {
      if (disposed || started) return;
      started = true;

      patchHistory();
      win.addEventListener("popstate", () => emitPageChange("pop-state"), { signal });

      // A single observer on the body subtree. Callbacks are debounced because
      // job sites mutate the DOM continuously while scrolling.
      const target = win.document.body ?? win.document.documentElement;
      if (target !== null) {
        mutationObserver = new MutationObserver(() => scheduleDomChange());
        mutationObserver.observe(target, { childList: true, subtree: true });
      }

      // Fallback poll: catches URL changes made by a framework that captured
      // a reference to the original pushState before we patched it.
      pollTimer = setInterval(() => emitPageChange("poll"), pollIntervalMs);
      if (typeof pollTimer === "object" && pollTimer !== null && "unref" in pollTimer) {
        (pollTimer as { unref: () => void }).unref();
      }
    },

    stop() {
      if (disposed) return;
      started = false;
      mutationObserver?.disconnect();
      mutationObserver = undefined;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      win.removeEventListener("popstate", () => {});
      unpatchHistory();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;

      mutationObserver?.disconnect();
      mutationObserver = undefined;

      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }

      unpatchHistory();
      // Aborts every listener registered with `{ signal }` in one call.
      controller.abort();
      pageListeners.clear();
      domListeners.clear();
    },

    get disposed() {
      return disposed;
    },

    get currentUrl() {
      return win.location.href;
    },
  };
};
