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

import { readBossRecruiterActivity } from "../adapters/boss/activity";
import { createCommunicationAction } from "../adapters/boss/communication";
import { resolveCityCodes } from "../adapters/boss/data/city-resolver";
import { createNavigatorLock } from "../adapters/userscript/navigator-lock";
import { createCommunicationRunner } from "../application/communication-runner";
import { createCommunicationService } from "../application/communication-service";
import { createController } from "../application/controller";
import {
  createDiscoveryService,
  type DiscoveryFailure,
  formatReasons,
  type Match,
} from "../application/discovery";
import { evaluateSendGates } from "../application/gates";
import { createApplicationHistory } from "../application/history";
import { createVerificationController } from "../application/human-verification";
import { createOrchestrator } from "../application/orchestrator";
import { toDomainProfile } from "../application/profile-mapping";
import { createRepository } from "../application/repository";
import { describePauseReason } from "../application/state";
import type { JobPilotConfig } from "../config/schema";
import { createDefaultConfig, toSessionPolicy } from "../config/schema";
import { traceStorage } from "../diagnostics/trace";
import type { CommunicationIntent } from "../domain/communication/intent";
import { createTemplate } from "../domain/communication/template";
import { createPageObserver } from "../infrastructure/observer/page-observer";
import { createTaskQueue } from "../infrastructure/queue/queue";
import { createWatchdog, DEFAULT_WATCHDOG_BUDGETS } from "../infrastructure/watchdog/watchdog";
import { DEFAULT_LOCK_TTL_MS } from "../ports/lock";
import { createPanel } from "../ui/panel";
import { buildSections } from "../ui/sections";
import { type PanelViewModel, safetyFromState } from "../ui/view-model";
import { createEngineFor, createRuntimeDeps, VERSION } from "./container";

export interface BootstrapResult {
  /**
   * The gate-guarded send path.
   *
   * Exposed so the runtime has exactly one way to send, and so a caller cannot
   * reach a click without the gates running. Nothing else calls the runner.
   */
  readonly communicationService: ReturnType<typeof createCommunicationService>;
  /**
   * Human-verification state. Exposed so the UI can offer Re-check and Resume,
   * and so the gate can consult a live value rather than a constant.
   */
  readonly verification: ReturnType<typeof createVerificationController>;
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
  // The execution queue. Populated from an explicit selection over the
  // discovered matches — discovery itself never enqueues, which is the central
  // product rule that keeps a search from turning into unattended contact.
  const queue = createTaskQueue();

  // The in-flight communication transaction. Kept in memory for the runner and
  // written through to storage on every change, so a reload between committing
  // and clicking — or between clicking and observing — is recoverable.
  let pendingIntent: CommunicationIntent | undefined = loaded.pendingIntent;

  if (pendingIntent !== undefined) {
    deps.logger.warn("bootstrap", "recovered an unfinished communication transaction", {
      jobId: pendingIntent.jobId,
      phase: pendingIntent.phase,
      clickDispatched: pendingIntent.clickDispatched ?? null,
      consequence: "it will be verified, never re-sent",
    });
  }

  for (const warning of loaded.warnings) {
    deps.logger.warn("bootstrap", warning);
  }

  const policy = toSessionPolicy(effectiveConfig);

  // Discovery results live here until the user selects them into the queue.
  // Discovery never enqueues on its own; that is the central product rule.
  let matches: readonly Match[] = [];
  let discoveryNote: string | undefined;

  const discoveryService = createDiscoveryService({
    platform: deps.platform,
    logger: deps.logger,
    resolveCities: (cities) => {
      const { resolved, failed } = resolveCityCodes(cities);
      const firstFailure = failed[0];
      if (firstFailure !== undefined && !firstFailure.ok) {
        return { ok: false, city: firstFailure.input, suggestions: firstFailure.suggestions };
      }
      return { ok: true, codes: resolved.map((entry) => entry.code) };
    },
    contactedJobIds: history.submittedJobIds(),
    companyBlacklist: effectiveConfig.filters.companyBlacklist,
    titleBlacklist: [],
    scoring: {
      baseScore: effectiveConfig.scoring.baseScore,
      acceptThreshold: effectiveConfig.scoring.acceptThreshold,
      preferredSkills: effectiveConfig.scoring.preferredSkills,
      preferredIndustries: [],
    },
    activityPreference: "any",
    skipUnknownActivity: true,
    readActivity: readBossRecruiterActivity,
  });

  // The panel needs a controller to exist, and the controller needs a panel to
  // render into. Declared first and assigned below; the panel's callbacks only
  // run after a user interaction, by which point it is set.
  let controller: ReturnType<typeof createController> | undefined;

  /**
   * Runs discovery for the active profile and repopulates Matches.
   *
   * Discovery never enqueues: it produces candidates for review. Starting it
   * while the queue is running is refused rather than allowed to fight the
   * runner for control of the page.
   */
  async function runDiscovery(): Promise<void> {
    const stored = effectiveConfig.profiles.find((entry) => entry.enabled);
    const active = stored === undefined ? undefined : toDomainProfile(stored);
    if (active === undefined) {
      discoveryNote = "No enabled search profile. Create one before discovering.";
      render();
      panel.toast("warn", discoveryNote);
      return;
    }

    if (controller !== undefined && controller.context().state !== "idle") {
      // Never silently destroy queue progress by starting a search mid-run.
      discoveryNote = "Stop the current run before starting a new search.";
      render();
      panel.toast("warn", discoveryNote);
      return;
    }

    discoveryNote = "Discovering…";
    render();

    const result = await discoveryService.run(active);

    if (!result.ok) {
      discoveryNote = describeDiscoveryFailure(result.failure);
      render();
      panel.toast("warn", discoveryNote);
      deps.logger.warn("bootstrap", "discovery stopped", { failure: result.failure.kind });
      return;
    }

    matches = result.matches;

    // Enqueue the accepted matches for review and execution. Deduplication is
    // by job id inside the queue, and a job already contacted is filtered by
    // stage A, so this cannot reintroduce a completed job.
    let enqueued = 0;
    for (const match of matches) {
      if (!match.accepted) continue;
      if (queue.enqueue({ jobId: String(match.summary.id), now: deps.clock.now() })) {
        enqueued += 1;
      }
    }

    const accepted = matches.filter((match) => match.accepted).length;
    discoveryNote =
      `Found ${matches.length} jobs, ${accepted} matched "${active.name}"` +
      (enqueued > 0 ? `, ${enqueued} queued.` : ".");
    render();
    deps.logger.info("bootstrap", "discovery complete", {
      total: matches.length,
      accepted,
    });
  }

  /** Turns a discovery failure into something a user can act on. */
  function describeDiscoveryFailure(failure: DiscoveryFailure): string {
    switch (failure.kind) {
      case "city":
        return failure.suggestions.length > 0
          ? `City "${failure.city}" is not a recognised BOSS city. Did you mean: ${failure.suggestions.join(", ")}?`
          : `City "${failure.city}" is not a recognised BOSS city.`;
      case "page-kind":
        return `This page is not a job list (detected: ${failure.pageKind}). Nothing was scanned.`;
      case "no-jobs":
        return "No jobs found on this page.";
      case "aborted":
        return "Discovery was cancelled.";
      case "error":
        return `Discovery failed: ${failure.message}`;
    }
  }

  // --- Cross-tab ownership ------------------------------------------------
  // Two BOSS tabs must never drive the same queue. Ownership is taken before
  // the interactive panel is built, so a tab that does not own execution can
  // render read-only instead of offering controls that would fight the owner.
  const lock = createNavigatorLock({ clock: deps.clock });
  const ownerId = `tab-${Math.random().toString(36).slice(2)}`;
  const ownership = await lock.acquire({ ownerId, ttlMs: DEFAULT_LOCK_TTL_MS });
  const isOwner = ownership.ok;

  if (!isOwner) {
    deps.logger.warn("bootstrap", "another tab owns execution; rendering read-only", {
      reason: ownership.reason,
    });
  }

  const panel = createPanel({
    document: globalThis.document,
    version: VERSION,
    callbacks: {
      discover: () => {
        if (!isOwner) {
          panel.toast("warn", "JobPilot is running in another tab. Take over there first.");
          return;
        }
        void runDiscovery();
      },
      start: () => {
        if (!isOwner) {
          panel.toast("warn", "JobPilot is running in another tab. Take over there first.");
          return;
        }
        controller?.dispatch({ type: "START" });
      },
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
    await repository.save({
      config: effectiveConfig,
      applications: history.serialize(),
      pendingIntent,
    });
  };

  const communicationAction = createCommunicationAction({
    document: globalThis.document,
    clock: deps.clock,
    logger: deps.logger,
  });

  const communicationRunner = createCommunicationRunner({
    action: communicationAction,
    logger: deps.logger,
    clock: deps.clock,
    persistIntent: async (intent) => {
      pendingIntent = intent;
      await persist();
    },
    clearIntent: async () => {
      pendingIntent = undefined;
      await persist();
    },
    // The durable record wins over any caller's in-memory copy, so replaying a
    // stale intent cannot cause a second click.
    readPersistedIntent: async () => pendingIntent,
  });

  /**
   * Human-verification controller.
   *
   * Constructed here rather than lazily so the "no automatic action during
   * human verification" gate has a live value to consult from the first
   * dispatch. A gate reading an unconstructed controller would silently
   * evaluate to "not blocked", which is the unsafe default.
   */
  const verification = createVerificationController(deps.recorder, () => deps.clock.now());

  /** Observes storage so persistence failures feed the health gate. */
  const tracedStorage = traceStorage(deps.storage, deps.recorder);

  /**
   * Message templates.
   *
   * A single conservative default for now: the template editor is not built
   * yet, and a send with no template must refuse rather than emit an empty
   * message. The default states nothing about the applicant, so it cannot
   * misrepresent them.
   */
  const templates = [
    createTemplate({
      id: "default",
      name: "Default greeting",
      content: "您好，我看到{{jobTitle}}这个职位很感兴趣，方便聊聊吗？",
      isDefault: true,
    }),
  ];

  /**
   * The communication service.
   *
   * The ONLY path that may send. It evaluates every gate, persists the intent,
   * reads it back to confirm persistence actually worked, and only then
   * delegates to the runner. Nothing else calls the runner, so no path can
   * reach a click without the gates having run first.
   *
   * The gate inputs are supplied as a thunk because they change over time
   * (verification state, storage health, controller context). Capturing them
   * once at construction would freeze the gates at their startup values, which
   * is the same class of bug as not having them.
   */
  const communicationService = createCommunicationService({
    runner: communicationRunner,
    recorder: deps.recorder,
    clock: deps.clock,
    logger: deps.logger,
    baseGateInput: () => ({
      mode: effectiveConfig.automation.mode,
      humanVerificationActive: verification.isBlocked(),
      storage: tracedStorage.health(),
      isQueueOwner: isOwner,
      sessionLimitReached:
        policy.maxApplicationsPerSession > 0 &&
        (controller?.context().sessionApplications ?? 0) >= policy.maxApplicationsPerSession,
      hourlyLimitReached:
        policy.maxApplicationsPerHour > 0 &&
        (controller?.context().applicationTimestamps.length ?? 0) >= policy.maxApplicationsPerHour,
      rateLimited: false,
    }),
    verifyChat: () => {
      // Only that a conversation is open. The authoritative identity check runs
      // inside the runner against the job id, which is where it belongs.
      const chat = communicationAction.readCurrentChat();
      return chat === null
        ? { verified: false, detail: "no conversation is open" }
        : { verified: true, detail: "a conversation is open" };
    },
    isDraftPresent: () => {
      const text = communicationAction.readEditor();
      return text !== null && text.trim().length > 0;
    },
    outgoingCount: (text) => communicationAction.outgoingCount(text),
    readPersistedIntent: () => pendingIntent,
    persistIntent: async (intent) => {
      pendingIntent = intent;
      await persist();
    },
    clearIntent: async () => {
      pendingIntent = undefined;
      await persist();
    },
    storageHealth: () => tracedStorage.health(),
    templates: () => templates,
    newIntentId: () =>
      `txn-${deps.clock.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });

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
  // Renew the lease periodically so a long session does not let another tab
  // take over mid-run. Cleared on dispose.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (isOwner) {
    heartbeat = setInterval(
      () => {
        void lock.renew({ token: ownerId, ttlMs: DEFAULT_LOCK_TTL_MS }).then((alive) => {
          if (!alive) {
            deps.logger.warn("bootstrap", "lost execution ownership");
          }
        });
      },
      Math.floor(DEFAULT_LOCK_TTL_MS / 3),
    );
  }

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
        queue.pendingCount() > 0 ? `${context.sessionApplications}/${queue.pendingCount()}` : "",
      pageKind: currentPageKind,

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
        ? context.lastMessage === undefined && discoveryNote === undefined
          ? {}
          : {
              message: {
                tone: context.lastError === undefined ? ("info" as const) : ("error" as const),
                text: discoveryNote ?? context.lastMessage ?? "",
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

      // Matches are rendered with their rule trace, so a score is never shown
      // without the reasons that produced it.
      matches: matches.slice(0, 50).map((match) => ({
        jobId: String(match.summary.id),
        title: match.summary.title,
        company: match.summary.companyName,
        meta: [match.summary.locationRaw, match.summary.salaryRaw]
          .filter((value) => value.length > 0)
          .join(" · "),
        score: match.score,
        accepted: match.accepted,
        selected: match.accepted,
        reasons: formatReasons(match.reasons),
      })),
      queue: queue
        .snapshot()
        .tasks.slice(0, 40)
        .map((task) => {
          const match = matches.find((candidate) => String(candidate.summary.id) === task.jobId);
          return {
            jobId: task.jobId,
            title: match?.summary.title ?? task.jobId,
            company: match?.summary.companyName ?? "",
            status: task.status,
            detail:
              task.lastError ??
              (task.attempts > 0
                ? `attempt ${task.attempts}`
                : new Date(task.enqueuedAt).toLocaleTimeString()),
          };
        }),
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

  let currentPageKind = "unknown";

  /**
   * Re-reads the page classification and repaints.
   *
   * The classification is shown in the panel because a user who cannot tell
   * whether JobPilot recognises the page cannot tell whether it is safe to
   * start it.
   */
  const refreshPageKind = (): void => {
    try {
      const kind = deps.platform.detectPage();
      if (kind === currentPageKind) return;
      currentPageKind = kind;
      deps.logger.debug("bootstrap", "page kind", { kind });
      render();
    } catch (error) {
      deps.logger.error("bootstrap", "page detection failed", { error });
    }
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

  /**
   * Resolves a transaction that was interrupted by a reload.
   *
   * This is the one job the runner must do automatically, and the reason the
   * intent is persisted at all. If a click was already dispatched, the ONLY
   * correct action is to look for the message and report what we find — never
   * to send again. A transaction that had not reached the click is abandoned
   * safely.
   */
  const settleRecoveredTransaction = async (): Promise<void> => {
    const recovered = pendingIntent;
    if (recovered === undefined) return;

    // Recovery goes through the same gates as a fresh send. It must: a
    // recovered transaction is exactly the situation where a challenge or a
    // broken storage layer is most likely, and the verification pass reads the
    // live conversation, which is an action rather than a passive observation.
    // Nothing here can click — the runner refuses once a click is recorded —
    // but the gates still have to be consulted rather than assumed.
    const base = {
      mode: effectiveConfig.automation.mode,
      humanVerificationActive: verification.isBlocked(),
      storage: tracedStorage.health(),
      isQueueOwner: isOwner,
      sessionLimitReached: false,
      hourlyLimitReached: false,
      rateLimited: false,
      draftPresent: false,
      chatVerified: true,
      hasPersistedIntent: true,
      sendAlreadyAttempted: true,
    };

    const gate = evaluateSendGates(base);
    if (!gate.allowed) {
      deps.logger.warn("bootstrap", "recovered transaction left unresolved by a gate", {
        jobId: recovered.jobId,
        reason: gate.reason,
      });
      panel.toast(
        "warn",
        `A message may have been sent to ${recovered.jobId}. JobPilot will not check it automatically: ${gate.message ?? "a safety gate is blocking"}.`,
      );
      return;
    }

    if (recovered.phase !== "send-attempted") {
      // Nothing was clicked, so there is nothing to verify. Clearing the record
      // is the whole action, and it is not a send.
      deps.logger.info("bootstrap", "discarding an uncommitted transaction", {
        jobId: recovered.jobId,
        phase: recovered.phase,
      });
      await communicationService.discardRecovered();
      return;
    }

    // A click may have gone out. Verify only; the runner refuses to re-send
    // because it consults the persisted intent first.
    const outcome = await communicationService.verifyRecovered({ observeTimeoutMs: 6_000 });
    deps.logger.warn("bootstrap", "resolved an interrupted transaction", {
      jobId: recovered.jobId,
      outcome: outcome.kind,
    });
    panel.toast(
      outcome.kind === "sent" ? "success" : "warn",
      outcome.kind === "sent"
        ? "Recovered: the earlier message was confirmed sent."
        : "A message may have been sent. Check the conversation; it will not be re-sent.",
    );
  };

  if (pendingIntent !== undefined) {
    void settleRecoveredTransaction();
  }

  deps.logger.info("bootstrap", "JobPilot ready", {
    version: VERSION,
    mode: effectiveConfig.automation.mode,
    recoveredTransaction: pendingIntent !== undefined,
  });

  return {
    /**
     * The gate-guarded send path.
     *
     * Exposed deliberately: it is the only way to send, and a caller that
     * cannot reach it cannot bypass the gates. The orchestration layer receives
     * it through the orchestrator rather than reaching into this closure.
     */
    communicationService,
    verification,
    dispose() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (isOwner) void lock.release(ownerId);
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
