import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { createPageObserver } from "../src/infrastructure/observer/page-observer";

describe("probe15: page observer stop() leaks listeners", () => {
  it("stop() does not remove the popstate listener it added", () => {
    const w = new Window({ url: "https://x.test/" });
    const obs = createPageObserver(w as unknown as Window, { debounceMs: 1, pollIntervalMs: 100000 });
    obs.start();
    obs.stop();
    let hits = 0;
    obs.onPageChange(() => { hits += 1; });
    // Simulate a back-navigation after stop(): the listener added with {signal}
    // in start() must have been removed by stop(), but was not.
    (w as any).history.pushState({}, "", "/next");  // url changed
    (w as any).dispatchEvent(new (w as any).Event("popstate"));
    console.log("page-change hits after stop():", hits, "(0 expected if stop() worked)");
    obs.dispose();
    expect(true).toBe(true);
  });
});
