/**
 * JobPilot entry point.
 *
 * Wires the runtime together and owns the top-level lifecycle: mount the panel,
 * create the controller, attach the SPA observers, and dispose everything when
 * the page we were mounted for disappears.
 *
 * The important invariant here is that there is exactly one mounted controller
 * at a time. A route change disposes the old one before the new one is created,
 * so observers, timers and DOM nodes cannot accumulate.
 */
import { createController } from "../application/controller";
import { createApplicationHistory } from "../application/history";
import { createOrchestrator } from "../application/orchestrator";
import { createRepository } from "../application/repository";
import { describePauseReason } from "../application/state";
import type { JobPilotConfig } from "../config/schema";
import { createDefaultConfig, toSessionPolicy } from "../config/schema";
import { createPageObserver } from "../infrastructure/observer/page-observer";
import { createWatchdog, DEFAULT_WATCHDOG_BUDGETS } from "../infrastructure/watchdog/watchdog";
import { createPanel } from "../ui/panel";
import { buildSections } from "../ui/sections";
import { type PanelViewModel, safetyFromState } from "../ui/view-model";
import { createEngineFor, createRuntimeDeps, VERSION } from "./container";

export interface BootstrapResult {
  dispose(): void;
}

/**
 * Starts JobPilot in the current document.
 *
 * Configuration is resolved first because the logger's level comes from it.
 */
export const bootstrap = async (): Promise<BootstrapResult> => {
  const defaults = createDefaultConfig();
  return bootstrapWith(defaults);
};

const bootstrapWith = async (config: JobPilotConfig): Promise<BootstrapResult> => {
  const deps = createRuntimeDeps(config);
  const repository = createRepository(deps.storage, deps.logger);
  const loaded = await repository.load();
  const effectiveConfig = loaded.config;
  const engine = createEngineFor(effectiveConfig);
  const history = createApplicationHistory(loaded.applications);

  for (const warning of loaded.warnings) {
    deps.logger.warn("bootstrap", warning);
  }

  const policy = toSessionPolicy(effectiveConfig);

  // The panel needs a controller to exist, and the controller needs a panel to
  // render into. Declared first and assigned below; the panel's callbacks only
  // run after a user interaction, by which point it is set.
  let controller: ReturnType<typeof createController> | undefined;

  const panel = createPanel({
    document: globalThis.document,
    version: VERSION,
    callbacks: {
      start: () => controller?.dispatch({ type: "START" }),
      pause: () => controller?.dispatch({ type: "PAUSE", reason: { kind: "user" } }),
      resume: () => controller?.dispatch({ type: "RESUME" }),
      skipCurrent: () => {
        deps.logger.info("panel", "skip requested");
        controller?.dispatch({ type: "PAUSE", reason: { kind: "user" } });
      },
      stop: () => controller?.dispatch({ type: "STOP" }),
      setCollapsed: (collapsed) => {
        deps.logger.debug("panel", "collapsed changed", { collapsed });
      },
    },
  });

  globalThis.document.body.append(panel.host);

  const watchdog = createWatchdog({
    clock: deps.clock,
    budgets: DEFAULT_WATCHDOG_BUDGETS,
    onStall: (state, elapsed) => {
      deps.logger.warn("watchdog", "state stalled", { state, elapsed });
      controller?.dispatch({
        type: "WATCHDOG_TIMEOUT",
        evidence: `state ${state} stalled for ${elapsed}ms`,
      });
    },
  });

  const persist = async (): Promise<void> => {
    await repository.save({ config: effectiveConfig, applications: history.serialize() });
  };

  const orchestrator = createOrchestrator({
    platform: deps.platform,
    engine,
    history,
    storage: deps.storage,
    logger: deps.logger,
    clock: deps.clock,
    random: deps.random,
    config: { hard: effectiveConfig.filters, scoring: effectiveConfig.scoring },
    version: VERSION,
    persist,
    dispatch: (event) => controller?.dispatch(event),
    notify: (level, message) => {
      panel.toast(level, message);
      deps.logger.info("notify", message, { level });
    },
    onDiagnostic: (reason) => {
      deps.logger.warn("diagnostics", "automation paused", { reason: reason.kind });
    },
    delayPolicy: {
      minActionDelayMs: policy.minActionDelayMs,
      maxActionDelayMs: policy.maxActionDelayMs,
    },
    sessionPolicy: {
      maxApplicationsPerSession: policy.maxApplicationsPerSession,
      maxApplicationsPerHour: policy.maxApplicationsPerHour,
      maxRetries: policy.maxRetries,
    },
  });

  /**
   * Renders the panel from current application state.
   *
   * The panel is a pure function of this view model, so a rendering bug can be
   * reproduced by constructing the same object in a test.
   */
  const render = (): void => {
    if (controller === undefined) return;
    const context = controller.context();
    const safety = safetyFromState(context.state, effectiveConfig.automation.mode);
    const records = history.all();

    const partial: Omit<PanelViewModel, "sections"> = {
      state: context.state,
      mode: effectiveConfig.automation.mode,
      safety: safety.level,
      safetyLabel: safety.label,
      launcherCount:
        context.queueDepth > 0 ? `${context.sessionApplications}/${context.queueDepth}` : "",

      running: [
        "scanning",
        "evaluating",
        "opening",
        "validating",
        "applying",
        "verifying",
        "cooldown",
      ].includes(context.state),
      paused:
        context.state === "paused" || context.state === "blocked" || context.state === "failed",

      ...(context.pauseReason === undefined
        ? context.lastMessage === undefined
          ? {}
          : {
              message: {
                tone: context.lastError === undefined ? ("info" as const) : ("error" as const),
                text: context.lastMessage,
              },
            }
        : {
            blocked: {
              reason: describePauseReason(context.pauseReason),
              body: "JobPilot has stopped all actions. Your queue and progress are saved. Resolve the page state, then choose Resume.",
              canResume: true,
            },
          }),

      ...(context.currentJob === undefined
        ? {}
        : {
            current: {
              title: context.currentJob.title,
              company: context.currentJob.companyName,
              phase: context.state,
            },
          }),

      // A send whose outcome is unobservable is surfaced as a decision rather
      // than silently retried or silently dropped.
      decisions: records
        .filter((record) => record.status === "submitted")
        .map((record) => ({
          kind: "uncertain-send" as const,
          jobId: String(record.jobId),
          title: String(record.jobId),
          message:
            "A message may have been sent. Check the conversation before continuing; this job will not be retried automatically.",
          actions: [
            { id: "open", label: "Open conversation" },
            { id: "mark-sent", label: "Mark as sent" },
            { id: "mark-not-sent", label: "Mark as not sent" },
          ],
        })),

      stats: [
        { label: "Scanned", value: context.stats.scanned },
        { label: "Accepted", value: context.stats.accepted },
        { label: "Applied", value: context.stats.applied },
        { label: "Skipped", value: context.stats.skipped },
        { label: "Blocked", value: context.stats.blocked },
        { label: "Failed", value: context.stats.failed },
      ],

      matches: [],
      queue: [],
      history: records.slice(-40).map((record) => ({
        jobId: String(record.jobId),
        title: String(record.jobId),
        company: record.platform,
        outcome: record.status,
        meta: record.reasons.at(-1) ?? new Date(record.updatedAt).toLocaleTimeString(),
      })),
      logs: deps.logger
        .entries()
        .slice(-40)
        .reverse()
        .map((entry) => ({
          level: entry.level,
          time: new Date(entry.timestamp).toLocaleTimeString(),
          component: entry.component,
          message: entry.message,
        })),
    };

    const view: PanelViewModel = {
      ...partial,
      sections: buildSections(globalThis.document, {
        ...(partial.message === undefined ? {} : { message: partial.message }),
        ...(partial.blocked === undefined ? {} : { blocked: partial.blocked }),
        ...(partial.current === undefined ? {} : { current: partial.current }),
        decisions: partial.decisions,
        stats: partial.stats,
        matches: partial.matches,
        queue: partial.queue,
        history: partial.history,
        logs: partial.logs,
      }),
    };

    panel.render(view);
  };

  controller = createController({
    clock: deps.clock,
    logger: deps.logger,
    orchestrator,
    history,
    watchdog,
    maxRetries: policy.maxRetries,
    onChange: render,
    onPersist: persist,
  });

  // --- SPA lifecycle ------------------------------------------------------
  const pageObserver = createPageObserver(window);

  const refreshPageKind = (): void => {
    const kind = deps.platform.detectPage();
    deps.logger.debug("bootstrap", "page kind", { kind });
  };

  pageObserver.onPageChange(() => {
    const before = deps.platform.detectPage();
    // Give the SPA a moment to render the new route's DOM before re-reading it.
    setTimeout(() => {
      try {
        const after = deps.platform.detectPage();
        refreshPageKind();
        if (after !== before) {
          controller?.dispatch({ type: "PAGE_CHANGED", pageKind: after });
        }
      } catch (error) {
        deps.logger.error("bootstrap", "page re-detection failed", { error });
      }
    }, 500);
  });

  pageObserver.onDomChange(refreshPageKind);
  pageObserver.start();
  refreshPageKind();
  render();

  deps.logger.info("bootstrap", "JobPilot ready", {
    version: VERSION,
    mode: effectiveConfig.automation.mode,
  });

  return {
    dispose() {
      pageObserver.dispose();
      controller?.dispose();
      watchdog.reset();
      watchdog.stop();
      panel.dispose();
      controller = undefined;
    },
  };
};

export { bootstrapWith };
