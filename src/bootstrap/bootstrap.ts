/**
 * JobPilot entry point.
 *
 * Wires the runtime together and owns the top-level lifecycle: mount the
 * panel, create the controller, attach the SPA observers, and dispose
 * everything when the page we were mounted for disappears.
 *
 * The important invariant here is that there is exactly one mounted
 * controller at a time. A route change disposes the old one before the new
 * one is created, so observers, timers and DOM nodes cannot accumulate.
 */
import { createRuntimeDeps, createEngineFor, VERSION } from "./container";
import { createRepository } from "../application/repository";
import { createApplicationHistory } from "../application/history";
import { createTaskQueue } from "../infrastructure/queue/queue";
import { createController } from "../application/controller";
import { createOrchestrator } from "../application/orchestrator";
import {
  createWatchdog,
  DEFAULT_WATCHDOG_BUDGETS,
} from "../infrastructure/watchdog/watchdog";
import { createPageObserver } from "../infrastructure/observer/page-observer";
import { createPanel } from "../ui/panel";
import { createDefaultConfig, toSessionPolicy } from "../config/schema";
import type { JobPilotConfig } from "../config/schema";

export interface BootstrapResult {
  dispose(): void;
}

/**
 * Starts JobPilot in the current document.
 *
 * Resolves the configuration first (because the logger's level comes from it),
 * then delegates to `bootstrapWith`.
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
  const queue = createTaskQueue();

  for (const warning of loaded.warnings) {
    deps.logger.warn("bootstrap", warning);
  }

  const policy = toSessionPolicy(effectiveConfig);

  const panel = createPanel({
    document: globalThis.document,
    version: VERSION,
    callbacks: {
      onStart: () => controller?.dispatch({ type: "START" }),
      onPause: () => controller?.dispatch({ type: "PAUSE", reason: { kind: "user" } }),
      onResume: () => controller?.dispatch({ type: "RESUME" }),
      onStop: () => controller?.dispatch({ type: "STOP" }),
      onClearQueue: () => {
        queue.clearPending();
        deps.logger.info("panel", "cleared pending queue", { pending: queue.pendingCount() });
      },
      onOpenSettings: () => {
        panel.showToast("info", "Edit settings by exporting, editing, and re-importing the config.");
      },
      onExportConfig: () => {
        const json = JSON.stringify(effectiveConfig, null, 2);
        void navigator.clipboard?.writeText(json).then(
          () => panel.showToast("info", "Config copied to clipboard"),
          () => panel.showToast("warn", "Clipboard unavailable; see the logs for the config"),
        );
        deps.logger.info("panel", "exported config");
      },
      onImportConfig: (json) => {
        panel.showToast("warn", "Config import requires a reload in this build.");
        deps.logger.warn("panel", "config import requested", { bytes: json.length });
      },
    },
  });

  document.body.append(panel.root);

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
      panel.showToast(level, message);
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

  let controller: ReturnType<typeof createController> | undefined;

  const render = (): void => {
    if (controller === undefined) return;
    panel.update(controller.context(), history.all(), deps.logger.entries());
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

  // SPA lifecycle ---------------------------------------------------------
  const pageObserver = createPageObserver(window);

  const refreshPageKind = (): void => {
    const kind = deps.platform.detectPage();
    panel.setPageKind(kind, kind === "job-list" || kind === "job-detail");
    return;
  };

  pageObserver.onPageChange(() => {
    const before = deps.platform.detectPage();
    // Give the SPA a moment to render the new route's DOM.
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

  panel.setSettings({
    automationMode: effectiveConfig.automation.mode,
    maxPerSession: policy.maxApplicationsPerSession,
    maxPerHour: policy.maxApplicationsPerHour,
    minDelayMs: policy.minActionDelayMs,
    maxDelayMs: policy.maxActionDelayMs,
    maxRetries: policy.maxRetries,
    logLevel: effectiveConfig.logging.level,
  });

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
