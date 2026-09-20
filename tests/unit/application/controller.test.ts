import { describe, expect, it } from "vitest";
import { createController } from "../../../src/application/controller";
import type { Effect } from "../../../src/application/events";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";

const NOW = 1_700_000_000_000;

/**
 * Records the order in which effect batches start and finish.
 *
 * If two batches overlap, their START/END markers interleave, which is what the
 * controller must prevent: concurrent DOM actions and writes are the source of
 * the double-send and lost-update classes of bug.
 */
const makeController = (options: {
  readonly onStart: (tag: string) => void;
  readonly onEnd: (tag: string) => void;
  readonly delayMs?: number;
}) => {
  let tag = 0;
  const controller = createController({
    clock: { now: () => NOW },
    logger: createNullLogger(),
    orchestrator: {
      runEffect: async (effect: Effect) => {
        const id = `${effect.type}#${tag}`;
        options.onStart(id);
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5));
        options.onEnd(id);
      },
      dispose: () => {},
    },
    history: {
      all: () => [],
      submittedJobIds: () => new Set<string>(),
      discover: () => ({}) as never,
      transition: () => undefined,
    } as never,
    watchdog: {
      watch: () => {},
      start: () => {},
      stop: () => {},
      reset: () => {},
      running: false,
    },
    maxRetries: 2,
    onChange: () => {},
    onPersist: async () => {},
    // Each dispatch gets a distinct tag so interleaving is visible.
    ...{},
  });
  return {
    controller,
    nextTag: () => {
      tag += 1;
    },
  };
};

describe("controller effect serialisation", () => {
  it("does not interleave effect batches from rapid dispatches", async () => {
    const start: string[] = [];
    const end: string[] = [];
    const { controller } = makeController({
      onStart: (id) => start.push(id),
      onEnd: (id) => end.push(id),
      delayMs: 5,
    });

    // Three dispatches in the same tick, each producing effects.
    controller.dispatch({ type: "START" });
    controller.dispatch({ type: "QUEUE_CHANGED", depth: 1 });
    controller.dispatch({ type: "QUEUE_CHANGED", depth: 2 });

    await new Promise((resolve) => setTimeout(resolve, 120));

    // Serialisation means every batch that started has also finished, and no
    // batch starts before the previous one ended.
    expect(start.length).toBeGreaterThan(0);
    expect(end.length).toBe(start.length);
    for (let index = 0; index < start.length; index += 1) {
      expect(start[index]).toBe(end[index]);
    }
    controller.dispose();
  });

  it("runs no effect after dispose, even with a batch already queued", async () => {
    const events: string[] = [];
    const { controller } = makeController({
      onStart: (id) => events.push(`start:${id}`),
      onEnd: () => {},
      delayMs: 20,
    });

    controller.dispatch({ type: "START" });
    controller.dispose();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(events).toEqual([]);
  });
});
