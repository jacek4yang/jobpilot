/**
 * Explicit task queue.
 *
 * Kept deliberately simple: an ordered list of tasks with a status each.
 * There is no priority scheduling and no concurrency beyond one running task,
 * because driving a real job site with parallel actions is neither safe nor
 * useful.
 */
export type TaskStatus = "pending" | "running" | "success" | "skipped" | "failed" | "blocked";

export interface Task {
  readonly jobId: string;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly enqueuedAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}

export interface QueueSnapshot {
  readonly tasks: readonly Task[];
  readonly currentJobId?: string;
}

export interface EnqueueOptions {
  readonly jobId: string;
  readonly now: number;
}

/** Statuses that mean a task will not run again. */
const SETTLED: readonly TaskStatus[] = ["success", "skipped", "failed", "blocked"];

export const isSettled = (status: TaskStatus): boolean => SETTLED.includes(status);

export interface TaskQueue {
  enqueue(options: EnqueueOptions): boolean;
  /** Marks the next pending task as running and returns it. */
  takeNext(now: number): Task | undefined;
  update(jobId: string, status: TaskStatus, now: number, error?: string): void;
  /** Removes a queued task that has not settled. */
  remove(jobId: string): boolean;
  clear(): void;
  /** Clears everything except the currently running task. */
  clearPending(): void;
  snapshot(): QueueSnapshot;
  pendingCount(): number;
  has(jobId: string): boolean;
  /** Restores a persisted snapshot, resetting any `running` task to `pending`. */
  restore(snapshot: QueueSnapshot): void;
}

/**
 * Creates an in-memory queue.
 *
 * Deduplication is by `jobId` across all statuses: a job that already
 * succeeded is never enqueued again, which is the last line of defence behind
 * the application-history check.
 */
export const createTaskQueue = (): TaskQueue => {
  let tasks: Task[] = [];

  const indexOf = (jobId: string): number => tasks.findIndex((task) => task.jobId === jobId);

  return {
    enqueue({ jobId, now }) {
      if (indexOf(jobId) !== -1) return false;
      tasks = [
        ...tasks,
        { jobId, status: "pending", attempts: 0, enqueuedAt: now, updatedAt: now },
      ];
      return true;
    },

    takeNext(now) {
      const next = tasks.find((task) => task.status === "pending");
      if (next === undefined) return undefined;
      const updated: Task = { ...next, status: "running", attempts: next.attempts + 1, updatedAt: now };
      tasks = tasks.map((task) => (task.jobId === next.jobId ? updated : task));
      return updated;
    },

    update(jobId, status, now, error) {
      tasks = tasks.map((task) =>
        task.jobId === jobId
          ? {
              ...task,
              status,
              updatedAt: now,
              ...(error === undefined ? {} : { lastError: error }),
            }
          : task,
      );
    },

    remove(jobId) {
      const index = indexOf(jobId);
      if (index === -1) return false;
      const task = tasks[index];
      if (task !== undefined && task.status === "running") return false;
      tasks = tasks.filter((candidate) => candidate.jobId !== jobId);
      return true;
    },

    clear() {
      tasks = [];
    },

    clearPending() {
      tasks = tasks.filter((task) => task.status !== "pending");
    },

    snapshot() {
      const running = tasks.find((task) => task.status === "running");
      return {
        tasks: [...tasks],
        ...(running === undefined ? {} : { currentJobId: running.jobId }),
      };
    },

    pendingCount() {
      return tasks.filter((task) => task.status === "pending").length;
    },

    has(jobId) {
      return indexOf(jobId) !== -1;
    },

    restore(snapshot) {
      // A task that was `running` when the page reloaded has an unknown
      // outcome. Reset it to pending so it is re-evaluated; the application
      // record, not the queue, decides whether it may be submitted again.
      tasks = snapshot.tasks.map((task) =>
        task.status === "running" ? { ...task, status: "pending" } : task,
      );
    },
  };
};
