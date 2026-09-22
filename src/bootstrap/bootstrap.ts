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

import { extractBenefits } from "../adapters/boss/benefits";
import { createCommunicationAction } from "../adapters/boss/communication";
import { extractConcerns } from "../adapters/boss/concerns";
import { detectBossDetailedPageKind } from "../adapters/boss/parser/page-kind";
import { createNavigatorLock } from "../adapters/userscript/navigator-lock";
import { createCommunicationRunner } from "../application/communication-runner";
import { createCommunicationService } from "../application/communication-service";
import { createController } from "../application/controller";
import type { Match } from "../application/discovery";
import { evaluateExecutionGates } from "../application/gates";
import { createApplicationHistory } from "../application/history";
import {
  createVerificationController,
  VERIFICATION_MESSAGE,
  type VerificationKind,
} from "../application/human-verification";
import { createOrchestrator } from "../application/orchestrator";
import { createRepository, type LoadResult } from "../application/repository";
import {
  filterSummariesBySelection,
  type SelectedJobIdentity,
  validateSelectionSnapshot,
} from "../application/selection";
import { describePauseReason } from "../application/state";
import type { JobPilotConfig } from "../config/schema";
import { createDefaultConfig, toSessionPolicy } from "../config/schema";
import { createBundleExporter } from "../diagnostics/bundle/exporter";
import { EVENTS } from "../diagnostics/event";
import { DEFAULT_EFFECT_BUDGETS, traceOrchestrator } from "../diagnostics/instrument/effect-trace";
import { fingerprintPage, recordPageFingerprint } from "../diagnostics/instrument/page-fingerprint";
import { recordSelectorOutcome } from "../diagnostics/instrument/selector-trace";
import { reduceWithTrace } from "../diagnostics/instrument/state-trace";
import {
  recordDraftCheck,
  recordIdentityCheck,
  recordIntentCreated,
  recordSendAttemptPersisted,
  recordTransactionTerminal,
  recordVerification,
} from "../diagnostics/instrument/transaction-trace";
import { startSession as createDiagnosticSession, newSessionId } from "../diagnostics/session";
import { traceStorage } from "../diagnostics/trace";
import { type CommunicationIntent, isSendCommitted } from "../domain/communication/intent";
import { createTemplate } from "../domain/communication/template";
import { mergeJobSnapshot } from "../domain/workspace/merge";
import type {
  CustomTag,
  InterviewRecord,
  JobAnnotation,
  JobStage,
  PersonalPreference,
  PipelineRecord,
  StoredJob,
} from "../domain/workspace/types";
import { createPageObserver } from "../infrastructure/observer/page-observer";
import { createWatchdog, DEFAULT_WATCHDOG_BUDGETS } from "../infrastructure/watchdog/watchdog";
import { DEFAULT_LOCK_TTL_MS } from "../ports/lock";
import type { JobPilotBackupV1 } from "../storage/backup/backup-service";
import { openWorkspaceStorage } from "../storage/workspace-storage";
import { renderDiagnostics } from "../ui/diagnostics-view";
import { createHostEnhancer } from "../ui/host-enhancement/enhancer";
import { setLocale, t } from "../ui/i18n";
import { createPanel } from "../ui/panel";
import { buildSections } from "../ui/sections";
import { type PanelViewModel, safetyFromState, type UiCallbacks } from "../ui/view-model";
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
  // Every production repository operation must pass through the health
  // wrapper. Constructing a second wrapper later made the storage gate vacuous:
  // writes failed on the raw adapter while health still reported "healthy".
  const tracedStorage = traceStorage(deps.storage, deps.recorder);
  const repository = createRepository(tracedStorage.storage, deps.logger);
  let loaded: LoadResult;
  try {
    loaded = await repository.load();
  } catch (error) {
    // Keep the read-only UI and diagnostic export available, but never let an
    // unreadable durable store look like a fresh install. The trace wrapper has
    // already marked storage unhealthy, so every irreversible gate stays shut.
    const detail = error instanceof Error ? error.message : String(error);
    loaded = {
      config,
      applications: [],
      warnings: [`本地存储读取失败：${detail}。JobPilot 已进入只读模式。`],
      fresh: false,
      writeBlocked: true,
      pendingIntent: undefined,
    };
  }
  let effectiveConfig = loaded.config;
  setLocale(effectiveConfig.general.locale);
  const engine = createEngineFor(effectiveConfig);
  const history = createApplicationHistory(loaded.applications);

  // --- Workspace Storage (IndexedDB with in-memory fallback) ----------------
  const workspaceStorage = await openWorkspaceStorage();

  let workspaceJobs: readonly StoredJob[] = await workspaceStorage.jobs.listJobs();
  let workspaceAnnotations: readonly JobAnnotation[] =
    await workspaceStorage.annotations.listAnnotations();
  let workspacePipeline: readonly PipelineRecord[] = await workspaceStorage.pipeline.listAll();
  let workspaceInterviews: readonly InterviewRecord[] =
    await workspaceStorage.interviews.listInterviews();
  let workspaceTags: readonly CustomTag[] = await workspaceStorage.tags.listTags();

  let currentViewingJob: StoredJob | undefined;
  let currentViewingAnnotation: JobAnnotation | undefined;

  const reloadWorkspaceData = async (): Promise<void> => {
    workspaceJobs = await workspaceStorage.jobs.listJobs();
    workspaceAnnotations = await workspaceStorage.annotations.listAnnotations();
    workspacePipeline = await workspaceStorage.pipeline.listAll();
    workspaceInterviews = await workspaceStorage.interviews.listInterviews();
    workspaceTags = await workspaceStorage.tags.listTags();
    if (currentViewingJob) {
      currentViewingAnnotation = await workspaceStorage.annotations.getAnnotation(
        currentViewingJob.id,
      );
    }
  };

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
  let discoveryEpoch = 0;

  /**
   * Operator-facing run log: what the batch did, newest first. Surfaced on the
   * Home page (rendered by a follow-up); capped so a long session cannot grow
   * the panel DOM without bound.
   */
  let runLog: readonly { time: string; text: string }[] = [];
  const appendRunLog = (text: string): void => {
    const time = new Date(deps.clock.now()).toLocaleTimeString();
    runLog = [{ time, text }, ...runLog].slice(0, 80);
  };

  // Operator's batch selection: which discovered jobs the next run may touch.
  // Empty means no work, never "the whole listing". Populated from accepted
  // matches and frozen at Start. A stale or contradictory page snapshot fails
  // closed instead of broadening the selection.
  let selectedJobIds: ReadonlySet<string> = new Set();
  let selectionHref: string | undefined;
  let activeBatchSnapshot: ReadonlyMap<string, SelectedJobIdentity> | undefined;

  // The panel needs a controller to exist, and the controller needs a panel to
  // render into. Declared first and assigned below; the panel's callbacks only
  // run after a user interaction, by which point it is set.
  let controller: ReturnType<typeof createController> | undefined;

  /**
   * Scans the current BOSS listing and repopulates the explicit selection.
   *
   * Discovery never enqueues: it produces candidates for review. Starting it
   * while the queue is running is refused rather than allowed to fight the
   * runner for control of the page.
   */
  async function runDiscovery(): Promise<void> {
    if (controller !== undefined && controller.context().state !== "idle") {
      // Never silently destroy queue progress by starting a search mid-run.
      discoveryNote = "当前正在运行，请先停止后再开始新搜索。";
      render();
      panel.toast("warn", discoveryNote);
      return;
    }

    const epoch = ++discoveryEpoch;
    const hrefAtStart = globalThis.location?.href;
    discoveryNote = "正在扫描职位…";
    appendRunLog("开始扫描职位");
    render();

    const pageKind = deps.platform.detectPage();
    // A listing with the detail drawer open classifies as "job-detail" (the
    // drawer root is positive detail evidence), but the listing itself is
    // still on screen and scannable — mirror the scanJobs rule and refuse
    // only when no list container is present. Live regression 2026-09-22:
    // with a card pre-selected, discovery refused to scan an obvious list.
    const listPresent =
      pageKind === "job-list" ||
      (pageKind === "job-detail" &&
        globalThis.document?.querySelector(".job-list-container") !== null);
    if (!listPresent) {
      discoveryNote = `当前页面不是职位列表（识别为：${pageKind}），没有扫描。`;
      appendRunLog(discoveryNote);
      render();
      panel.toast("warn", discoveryNote);
      deps.logger.warn("bootstrap", "current-page scan refused", { pageKind });
      return;
    }

    try {
      const summaries = await deps.platform.scanJobs({ limit: 50 });
      if (epoch !== discoveryEpoch || globalThis.location?.href !== hrefAtStart) {
        discoveryNote = "页面在扫描期间发生变化，结果已丢弃，请重新扫描。";
        selectedJobIds = new Set();
        selectionHref = undefined;
        render();
        return;
      }
      matches = summaries.map((summary) => ({
        summary,
        accepted: true,
        score: 0,
        reasons: [],
        decidedAt: "A",
      }));
    } catch (error) {
      discoveryNote = `扫描失败：${error instanceof Error ? error.message : String(error)}`;
      appendRunLog(discoveryNote);
      render();
      panel.toast("error", discoveryNote);
      return;
    }

    selectedJobIds = new Set(matches.map((match) => String(match.summary.id)));
    selectionHref = globalThis.location?.href;
    activeBatchSnapshot = undefined;

    discoveryNote =
      matches.length === 0
        ? "这个页面上没有找到职位。"
        : `当前页识别到 ${matches.length} 个职位，已默认勾选；请取消不想处理的职位。`;
    appendRunLog(discoveryNote);
    render();
    deps.logger.info("bootstrap", "discovery complete", {
      total: matches.length,
      selected: selectedJobIds.size,
    });
  }

  // --- Cross-tab ownership ------------------------------------------------
  // Two BOSS tabs must never drive automation at once. Ownership is acquired
  // only when executable work starts. Discovery and selection are read-only;
  // taking the origin-wide lock for either would let an idle tab monopolise it.
  const lock = createNavigatorLock({ clock: deps.clock });
  const ownerId = `tab-${Math.random().toString(36).slice(2)}`;
  let isOwner = false;
  let startRequestPending = false;
  let startRequestEpoch = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const startOwnershipHeartbeat = (): void => {
    if (heartbeat !== undefined) return;
    heartbeat = setInterval(
      () => {
        void lock.renew({ token: ownerId, ttlMs: DEFAULT_LOCK_TTL_MS }).then((alive) => {
          if (alive) return;
          isOwner = false;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          heartbeat = undefined;
          deps.logger.warn("bootstrap", "lost execution ownership");
          controller?.dispatch({
            type: "BLOCKED",
            reason: "ambiguous-state",
            evidence: "另一个标签页已接管运行权",
          });
        });
      },
      Math.floor(DEFAULT_LOCK_TTL_MS / 3),
    );
  };

  const ensureOwnership = async (): Promise<boolean> => {
    if (isOwner) return true;
    const ownership = await lock.acquire({ ownerId, ttlMs: DEFAULT_LOCK_TTL_MS });
    if (!ownership.ok) {
      deps.logger.warn("bootstrap", "another tab owns execution", { reason: ownership.reason });
      return false;
    }
    isOwner = true;
    startOwnershipHeartbeat();
    return true;
  };

  const releaseOwnership = (): void => {
    if (!isOwner) return;
    isOwner = false;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    void lock.release(ownerId);
  };

  const panelCallbacks: UiCallbacks = {
    discover: () => {
      void runDiscovery();
    },
    onToggleMatchSelect: (jobId: string) => {
      if (controller !== undefined && controller.context().state !== "idle") {
        panel.toast("warn", "批量任务运行期间不能修改选择，请先停止。 ");
        return;
      }
      const next = new Set(selectedJobIds);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      selectedJobIds = next;
      render();
    },
    start: () => {
      if (startRequestPending) {
        panel.toast("warn", "正在检查运行权限，请勿重复开始。");
        return;
      }
      startRequestPending = true;
      const requestEpoch = ++startRequestEpoch;
      void ensureOwnership()
        .then((owned) => {
          if (requestEpoch !== startRequestEpoch) {
            if (owned) releaseOwnership();
            return;
          }
          if (!owned) {
            panel.toast("warn", "JobPilot 正在另一个标签页运行，请切换到那个页面操作。");
            return;
          }
          if (verification.isBlocked()) {
            panel.toast("warn", "BOSS 需要人工验证。请手动完成验证，然后点「重新检查页面」。");
            return;
          }
          if (controller === undefined || controller.context().state !== "idle") {
            panel.toast("warn", "当前任务已经在运行。");
            return;
          }
          if (!storageHealth().healthy) {
            panel.toast("error", "本地持久化不可用，已进入只读模式，不能开始自动沟通。");
            return;
          }
          const selected = new Map<string, SelectedJobIdentity>();
          for (const match of matches) {
            const id = String(match.summary.id);
            if (!selectedJobIds.has(id)) continue;
            selected.set(id, {
              id,
              title: match.summary.title,
              companyName: match.summary.companyName,
              ...(match.summary.url === undefined ? {} : { url: match.summary.url }),
              ...(match.summary.platformJobId === undefined
                ? {}
                : { platformJobId: match.summary.platformJobId }),
              idIsPlatformNative: match.summary.idIsPlatformNative,
            });
          }
          const selection = validateSelectionSnapshot(
            selected,
            selectionHref,
            globalThis.location?.href,
          );
          if (!selection.ok) {
            panel.toast(
              "warn",
              selection.reason === "empty"
                ? "请至少选择一个职位后再开始。"
                : "当前页面已变化，请重新扫描并选择职位。",
            );
            return;
          }
          const contacted = new Set([...history.submittedJobIds()].map(String));
          if ([...selected.keys()].some((id) => contacted.has(id))) {
            panel.toast("warn", "选择中包含已经沟通过的职位，请重新扫描。");
            return;
          }
          activeBatchSnapshot = selected;
          deps.recorder.record({
            level: "info",
            category: "user-action",
            event: EVENTS.userStart,
          });
          appendRunLog(`开始处理 ${selected.size} 个已选职位`);
          controller.dispatch({ type: "START" });
        })
        .finally(() => {
          startRequestPending = false;
          if (controller?.context().state === "idle") releaseOwnership();
        });
    },
    recheck: () => {
      void ensureOwnership().then((owned) => {
        if (!owned) {
          panel.toast("warn", "JobPilot 正在另一个标签页运行，请切换到那个页面操作。");
          return;
        }
        // Step one of the two-step recovery. This VALIDATES and reports; it
        // never resumes. Resuming is a separate, explicit user action.
        const pageKind = deps.platform.detectPage();
        const result = verification.recheck(
          {
            pageKind,
            loginValid: pageKind !== "login-required",
            riskPresent: pageKind === "captcha" || pageKind === "unknown",
            expectedRoute:
              pageKind === "job-list" || pageKind === "job-detail" || pageKind === "empty-result",
            storageHealthy: storageHealth().healthy,
            isQueueOwner: true,
          },
          deps.clock.now(),
        );
        panel.toast(
          result.result.ok ? "success" : "warn",
          result.result.ok ? "页面看起来正常了。准备好之后点「继续」。" : result.result.detail,
        );
        render();
      });
    },
    pause: () => {
      startRequestEpoch += 1;
      deps.recorder.record({
        level: "info",
        category: "user-action",
        event: EVENTS.userPause,
      });
      appendRunLog("暂停运行");
      controller?.dispatch({ type: "PAUSE", reason: { kind: "user" } });
      releaseOwnership();
    },
    resume: () => {
      void ensureOwnership().then((owned) => {
        if (!owned) {
          panel.toast("warn", "JobPilot 正在另一个标签页运行，请切换到那个页面操作。");
          return;
        }
        // A challenge disappearing is not sufficient: the user must have
        // re-checked the page and then explicitly pressed Resume.
        const state = verification.state();
        if (state.phase === "blocked" || state.phase === "still-blocked") {
          deps.recorder.warnEvent("risk", EVENTS.humanVerificationRecheck, {
            detail: "resume refused: the page has not been re-checked",
            phase: state.phase,
          });
          panel.toast(
            "warn",
            state.phase === "still-blocked"
              ? `暂时无法继续：${state.lastCheckDetail ?? "验证仍未完成"}。`
              : "请先在页面中完成验证，然后点「重新检查页面」。",
          );
          return;
        }
        if (state.phase === "ready") {
          verification.clear(deps.clock.now());
          deps.recorder.record({
            level: "info",
            category: "user-action",
            event: EVENTS.userCompletedVerification,
          });
        }
        deps.recorder.record({
          level: "info",
          category: "user-action",
          event: EVENTS.userResume,
        });
        appendRunLog("继续运行");
        controller?.dispatch({ type: "RESUME" });
      });
    },
    skipCurrent: () => {
      deps.logger.info("panel", "skip requested");
      controller?.dispatch({ type: "PAUSE", reason: { kind: "user" } });
    },
    stop: () => {
      startRequestEpoch += 1;
      appendRunLog("停止运行");
      controller?.dispatch({ type: "STOP" });
      releaseOwnership();
    },
    setCollapsed: (collapsed: boolean) => {
      effectiveConfig = {
        ...effectiveConfig,
        ui: {
          ...effectiveConfig.ui,
          collapsed,
        },
      };
      void persist();
      deps.logger.debug("panel", "collapsed changed", { collapsed });
    },
    onSaveLayout: (geo: {
      readonly width: number;
      readonly height: number;
      readonly x: number;
      readonly y: number;
      readonly collapsed: boolean;
    }) => {
      effectiveConfig = {
        ...effectiveConfig,
        ui: {
          ...effectiveConfig.ui,
          panelWidth: geo.width,
          panelHeight: geo.height,
          panelPosition: { x: geo.x, y: geo.y },
          collapsed: geo.collapsed,
        },
      };
      void persist();
    },
    onResetLayout: () => {
      effectiveConfig = {
        ...effectiveConfig,
        ui: {
          ...effectiveConfig.ui,
          panelWidth: undefined,
          panelHeight: undefined,
          panelPosition: "bottom-right",
          collapsed: false,
        },
      };
      void persist();
      panel.toast("info", t("toast.layoutReset"));
    },
    onSaveDisplayName: (displayName: string) => {
      effectiveConfig = {
        ...effectiveConfig,
        general: {
          ...effectiveConfig.general,
          displayName: displayName.trim() || undefined,
        },
      };
      void persist();
      render();
    },
    onSaveSearchProfile: (profile) => {
      const existing = effectiveConfig.profiles ?? [];
      const index = existing.findIndex((candidate) => candidate.id === profile.id);
      effectiveConfig = {
        ...effectiveConfig,
        profiles:
          index >= 0
            ? existing.map((candidate, i) => (i === index ? profile : candidate))
            : [...existing, profile],
      };
      void persist();
      // Deliberately NO render() here: a keystroke must not rebuild the panel
      // DOM, or the input being typed into loses focus. The Search page's
      // module-scope draft already keeps values consistent, and the next
      // natural render (any state update) picks the persisted profile up.
    },

    // Personal Job Workspace callbacks
    onSetPreference: async (jobId: string, preference: PersonalPreference) => {
      await workspaceStorage.annotations.updatePreference(jobId, preference, deps.clock.now());
      if (preference === "favorite") {
        await workspaceStorage.pipeline.setStage(jobId, "favorite", deps.clock.now());
      }
      await reloadWorkspaceData();
      hostEnhancer.refresh();
      render();
    },
    onSaveNote: async (jobId: string, note: string) => {
      await workspaceStorage.annotations.updateNote(jobId, note, deps.clock.now());
      await reloadWorkspaceData();
      hostEnhancer.refresh();
      render();
    },
    onTogglePin: async (jobId: string) => {
      await workspaceStorage.annotations.togglePin(jobId, deps.clock.now());
      await reloadWorkspaceData();
      render();
    },
    onToggleTag: async (
      jobId: string,
      category: "positive" | "concern" | "question" | "custom",
      tag: string,
    ) => {
      await workspaceStorage.annotations.toggleTag(jobId, category, tag, deps.clock.now());
      await reloadWorkspaceData();
      render();
    },
    onUpdateQuestions: async (jobId: string, questions) => {
      const ann = await workspaceStorage.annotations.getOrCreateAnnotation(jobId, deps.clock.now());
      await workspaceStorage.annotations.saveAnnotation({
        ...ann,
        questions,
        updatedAt: deps.clock.now(),
      });
      await reloadWorkspaceData();
      render();
    },
    onSetPipelineStage: async (jobId: string, stage: JobStage, note?: string) => {
      await workspaceStorage.pipeline.setStage(jobId, stage, deps.clock.now(), note);
      await reloadWorkspaceData();
      hostEnhancer.refresh();
      render();
    },
    onSaveInterview: async (record: InterviewRecord) => {
      await workspaceStorage.interviews.saveInterview(record);
      await reloadWorkspaceData();
      render();
    },
    onDeleteInterview: async (id: string) => {
      await workspaceStorage.interviews.deleteInterview(id);
      await reloadWorkspaceData();
      render();
    },
    onExportBackup: async () => {
      const backup = await workspaceStorage.backup.exportBackup(VERSION, deps.clock.now());
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = globalThis.document.createElement("a");
      a.href = url;
      a.download = `jobpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      globalThis.document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      panel.toast("success", "已成功导出备份文件");
    },
    onImportBackup: async (backup: JobPilotBackupV1, mode: "merge" | "replace") => {
      try {
        const result = await workspaceStorage.backup.importBackup(backup, mode);
        panel.toast(
          "success",
          t("backup.importSuccess", {
            jobs: result.importedJobs,
            notes: result.importedAnnotations,
          }),
        );
        await reloadWorkspaceData();
        hostEnhancer.refresh();
        render();
      } catch {
        panel.toast("error", t("backup.importInvalid"));
      }
    },
    onPruneData: async () => {
      await workspaceStorage.prune(deps.clock.now());
      panel.toast("success", t("backup.cleanSuccess"));
      await reloadWorkspaceData();
      render();
    },
    onClearAllData: async () => {
      await workspaceStorage.jobs.clearAll();
      await workspaceStorage.annotations.clearAll();
      await workspaceStorage.pipeline.clearAll();
      await workspaceStorage.tags.clearAll();
      await workspaceStorage.interviews.clearAll();
      panel.toast("success", t("backup.clearSuccess"));
      await reloadWorkspaceData();
      hostEnhancer.refresh();
      render();
    },
    onSelectTab: (tab) => {
      panel.selectTab(tab);
    },
  };

  const panel = createPanel({
    document: globalThis.document,
    version: VERSION,
    startCollapsed: effectiveConfig.ui.collapsed ?? effectiveConfig.ui.compactMode,
    geometry: {
      width: effectiveConfig.ui.panelWidth,
      height: effectiveConfig.ui.panelHeight,
      position: effectiveConfig.ui.panelPosition,
      collapsed: effectiveConfig.ui.collapsed,
    },
    callbacks: panelCallbacks,
  });

  globalThis.document.body.append(panel.host);

  const hostEnhancer = createHostEnhancer({
    document: globalThis.document,
    getBadgeData: async (jobId: string) => {
      const ann = await workspaceStorage.annotations.getAnnotation(jobId);
      const pipe = await workspaceStorage.pipeline.getPipeline(jobId);
      if (!ann && !pipe) return undefined;
      return {
        preference: ann?.preference,
        stage: pipe?.stage,
        hasNote: Boolean(ann?.note && ann.note.trim().length > 0),
      };
    },
    onOpenJobSummary: () => {
      panel.selectTab("jobs");
      panel.expand();
    },
  });
  hostEnhancer.start();

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
    const result = await repository.save({
      config: effectiveConfig,
      applications: history.serialize(),
      pendingIntent,
    });
    if (!result.saved) {
      throw new Error(result.reason ?? "本地存储拒绝写入");
    }
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
      const previous = pendingIntent;
      pendingIntent = intent;
      try {
        await persist();
      } catch (error) {
        pendingIntent = previous;
        throw error;
      }
    },
    clearIntent: async () => {
      const previous = pendingIntent;
      pendingIntent = undefined;
      try {
        await persist();
      } catch (error) {
        pendingIntent = previous;
        throw error;
      }
    },
    // The durable record wins over any caller's in-memory copy, so replaying a
    // stale intent cannot cause a second click.
    readPersistedIntent: async () => (await repository.load()).pendingIntent,
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

  const storageHealth = (): import("../diagnostics/trace").StorageHealth => {
    const traced = tracedStorage.health();
    if (!traced.healthy) return traced;
    if (!deps.durableStorage) {
      return { healthy: false, lastFailure: "GM 持久化不可用，当前仅为临时只读会话" };
    }
    if (loaded.writeBlocked) {
      return { healthy: false, lastFailure: "持久化文档无法安全读取，写入已禁用" };
    }
    return traced;
  };

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
      storage: storageHealth(),
      isQueueOwner: isOwner,
      sessionLimitReached:
        policy.maxApplicationsPerSession > 0 &&
        (controller?.context().sessionApplications ?? 0) >= policy.maxApplicationsPerSession,
      hourlyLimitReached:
        policy.maxApplicationsPerHour > 0 &&
        (controller?.context().applicationTimestamps.length ?? 0) >= policy.maxApplicationsPerHour,
      rateLimited: false,
    }),
    // The adapter owns selector knowledge; the service only asks whether the
    // affordance resolved and which candidate won. That keeps selector detail
    // inside the adapter while still producing the diagnostic.
    resolveCommunicateAction: () => {
      const located = communicationAction.findCommunicateButton();
      return located === null
        ? null
        : { matchedBy: located.matchedBy, heuristic: located.heuristic };
    },
    onCommunicateButtonResolved: (outcome) => {
      recordSelectorOutcome(deps.recorder, outcome);
    },
    outgoingCount: (text) => communicationAction.outgoingCount(text),
    readPersistedIntent: () => pendingIntent,
    persistIntent: async (intent) => {
      const previous = pendingIntent;
      pendingIntent = intent;
      try {
        await persist();
      } catch (error) {
        pendingIntent = previous;
        throw error;
      }
      // Recorded AFTER the write succeeds, so the event means "this is durable"
      // rather than "we tried". The analyzer relies on that distinction when
      // judging whether a reload could have lost the point of no return.
      const context = { transactionId: intent.id, jobId: String(intent.jobId) };
      if (intent.sendAttemptedAt !== undefined) {
        recordSendAttemptPersisted(deps.recorder, context, intent);
      }
    },
    clearIntent: async () => {
      const previous = pendingIntent;
      pendingIntent = undefined;
      try {
        await persist();
      } catch (error) {
        pendingIntent = previous;
        throw error;
      }
    },
    confirmPersistedIntent: async (intent) => {
      const durable = (await repository.load()).pendingIntent;
      return durable?.id === intent.id && durable.phase === intent.phase;
    },
    storageHealth,
    templates: () => templates,
    newIntentId: () =>
      `txn-${deps.clock.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // --- Transaction tracing -------------------------------------------------
    // The service reports each phase edge with the correlation ids, so a bundle
    // can reconstruct one send without reading the whole stream.
    onIntentCreated: ({
      transactionId,
      jobId,
      templateId,
      messageText,
      variablesUsed,
      outgoingBaseline,
      expiresAt,
    }) => {
      recordIntentCreated(
        deps.recorder,
        { transactionId, jobId },
        { templateId, messageText, variablesUsed, outgoingBaseline, expiresAt },
      );
    },
    onDraftChecked: ({ transactionId, jobId, present }) => {
      recordDraftCheck(deps.recorder, { transactionId, jobId }, present);
    },
    onIdentityChecked: ({ transactionId, jobId, verdict, signals }) => {
      recordIdentityCheck(deps.recorder, { transactionId, jobId }, { kind: verdict, signals });
    },
    onVerified: ({ transactionId, jobId, kind, outgoingCount, baseline }) => {
      recordVerification(
        deps.recorder,
        { transactionId, jobId },
        { kind, outgoingCount, baseline },
      );
    },
    onTerminal: ({ transactionId, jobId, kind, reason }) => {
      recordTransactionTerminal(
        deps.recorder,
        { transactionId, jobId },
        reason === undefined ? { kind } : { kind, reason },
      );
    },
  });

  // The execution pipeline only ever sees operator-selected jobs once a
  // selection exists. Discovery keeps the raw platform (step 1 must see the
  // whole listing). Execution uses an immutable identity snapshot and refuses
  // missing or contradictory cards instead of widening to the whole page.
  const platformForRun: typeof deps.platform = {
    ...deps.platform,
    scanJobs: async (options) => {
      const summaries = await deps.platform.scanJobs(options);
      const selected = activeBatchSnapshot ?? new Map<string, SelectedJobIdentity>();
      const validation = validateSelectionSnapshot(
        selected,
        selectionHref,
        globalThis.location?.href,
        summaries.map((summary) => ({
          id: String(summary.id),
          title: summary.title,
          companyName: summary.companyName,
          ...(summary.url === undefined ? {} : { url: summary.url }),
          ...(summary.platformJobId === undefined ? {} : { platformJobId: summary.platformJobId }),
          idIsPlatformNative: summary.idIsPlatformNative,
        })),
      );
      if (!validation.ok) {
        throw new Error(
          validation.reason === "empty"
            ? "没有已选职位"
            : validation.reason === "stale-page"
              ? "页面范围已变化，请重新扫描"
              : validation.reason === "missing-job"
                ? `已选职位 ${validation.jobId ?? ""} 已从页面消失`
                : `已选职位 ${validation.jobId ?? ""} 的身份信息发生冲突`,
        );
      }
      return filterSummariesBySelection(summaries, new Set(selected.keys()));
    },
  };

  const orchestrator = createOrchestrator({
    platform: platformForRun,
    communication: communicationService,
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
      const levelText = level === "error" ? "错误" : level === "warn" ? "警告" : "信息";
      appendRunLog(`${levelText}：${message}`);
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
  // -------------------------------------------------------------------------
  // Diagnostic bundle export
  //
  // The Diagnostics page buttons drive this. The exporter assembles the same
  // BundleInputs the analyzer consumes, builds the ZIP, and delivers it via
  // picker-or-download. The result is kept so the next render can show it on
  // the Diagnostics page; a failed export must never clear diagnostic memory.
  // -------------------------------------------------------------------------
  const bundleExporter = createBundleExporter({
    build: deps.build,
    recorder: deps.recorder,
    config: () => effectiveConfig,
    sections: () => ({
      "queue.json": {
        tasks:
          controller?.context().pendingSummaries.map((summary) => ({
            jobId: String(summary.id),
            status: "pending",
          })) ?? [],
      },
      ...(pendingIntent === undefined ? {} : { "transactions.json": [pendingIntent] }),
    }),
    health: () => ({
      storageHealthy: storageHealth().healthy,
      ...(storageHealth().lastFailure === undefined
        ? {}
        : { storageFailure: String(storageHealth().lastFailure) }),
      lockOwner: isOwner ? "this-tab" : "another-tab",
      humanVerificationEncountered: verification.state().phase !== "clear",
    }),
    environment: () => ({
      url: globalThis.location?.href,
      userAgent: globalThis.navigator?.userAgent,
    }),
    now: () => deps.clock.now(),
  });
  let lastExportResult: { ok: boolean; fileName?: string; error?: string } | undefined;

  const runExport = async (): Promise<void> => {
    const result = await bundleExporter.exportBundle();
    lastExportResult = result;
    panel.toast(
      result.ok ? "success" : "error",
      result.ok
        ? `诊断证据包已导出：${result.fileName ?? "bundle"}`
        : `导出失败：${result.error ?? "未知错误"}（诊断数据仍保留，可重试）`,
    );
    render();
  };

  const render = (): void => {
    if (controller === undefined) return;
    const context = controller.context();
    if (
      (context.state === "idle" && context.lastTerminalReason !== undefined) ||
      context.state === "paused" ||
      context.state === "blocked" ||
      context.state === "failed"
    ) {
      releaseOwnership();
    }
    const safety = safetyFromState(context.state, effectiveConfig.automation.mode);
    const records = history.all();

    const partial: Omit<PanelViewModel, "sections"> = {
      state: context.state,
      mode: effectiveConfig.automation.mode,
      safety: safety.level,
      safetyLabel: safety.label,
      launcherCount:
        context.pendingSummaries.length > 0
          ? `${context.sessionApplications}/${context.pendingSummaries.length}`
          : "",
      pageKind: currentPageKind,

      running: [
        "scanning",
        "evaluating",
        "opening",
        "validating",
        "contacting",
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
                text: context.lastMessage ?? "",
              },
            }
        : {
            blocked: {
              reason: describePauseReason(context.pauseReason),
              kind: context.pauseReason.kind,
              // For the human-gated contact step the generic "handle the page"
              // body would bury the one action that unblocks the batch, so the
              // pause reason's own evidence — the actionable message — is the
              // body here.
              body:
                context.pauseReason.kind === "needs-human-click"
                  ? context.pauseReason.evidence
                  : "JobPilot 已暂停所有操作。你的队列和进度都已保存。处理好页面状态后，点「继续」即可恢复。",
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
          message: t("decisions.uncertainSend"),
          actions: [
            { id: "open", label: t("decisions.openChat") },
            { id: "mark-sent", label: t("decisions.markSent") },
            { id: "mark-not-sent", label: t("decisions.markNotSent") },
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
        selected: selectedJobIds.has(String(match.summary.id)),
        reasons: match.reasons.map((reason) => reason.message),
      })),
      queue: context.pendingSummaries.slice(0, 40).map((summary) => ({
        jobId: String(summary.id),
        title: summary.title,
        company: summary.companyName,
        status: "pending",
        detail: "等待处理",
      })),
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
      config: effectiveConfig,
      displayName: effectiveConfig.general.displayName,
      channel: deps.build.channel,
      sections: buildSections(globalThis.document, {
        ...(partial.message === undefined ? {} : { message: partial.message }),
        ...(partial.blocked === undefined ? {} : { blocked: partial.blocked }),
        ...(partial.current === undefined ? {} : { current: partial.current }),
        decisions: partial.decisions,
        stats: partial.stats,
        matches: partial.matches,
        discoveryNote,
        runLog,
        selectedCount: matches.filter((m) => selectedJobIds.has(String(m.summary.id))).length,
        queue: partial.queue,
        history: partial.history,
        logs: partial.logs,
        config: effectiveConfig,
        displayName: effectiveConfig.general.displayName,
        callbacks: panelCallbacks,
        state: context.state,
        running: partial.running,
        paused: partial.paused,
        channel: deps.build.channel,

        // Personal Job Workspace integration
        pageKind: currentPageKind,
        isLoggedIn: currentPageKind !== "login-required",
        favoriteCount: workspaceAnnotations.filter((a) => a.preference === "favorite").length,
        queueCount: context.pendingSummaries.length,
        pipelineCount: workspacePipeline.filter(
          (p) => !["not-interested", "closed"].includes(p.stage),
        ).length,
        currentJob: currentViewingJob,
        currentAnnotation: currentViewingAnnotation,
        allJobs: workspaceJobs,
        allAnnotations: workspaceAnnotations,
        pipelineRecords: workspacePipeline,
        interviews: workspaceInterviews,
        customTags: workspaceTags,
        storageStats: {
          jobCount: workspaceJobs.length,
          favoriteCount: workspaceAnnotations.filter((a) => a.preference === "favorite").length,
          noteCount: workspaceAnnotations.filter((a) => Boolean(a.note && a.note.trim().length > 0))
            .length,
        },
      }),
    };

    if (deps.build.channel === "diagnostic") {
      const diagSections = view.sections as Record<string, HTMLElement>;
      diagSections.diagnostics = renderDiagnostics(
        globalThis.document,
        {
          build: deps.build,
          recorder: deps.recorder,
          verification: verification.state(),
          storageHealth: storageHealth(),
          exportResult: lastExportResult,
          isQueueOwner: isOwner,
          route: currentPageKind,
          state: context.state,
          currentJob: context.currentJob ? String(context.currentJob.id) : undefined,
          lastError: context.lastError,
          lastSelectorFailure: undefined,
        },
        {
          startSession: () => {
            // The runbook requires a deliberate, named session: the scenario id
            // is stamped onto every event so a bundle can be attributed to a
            // matrix row. Prompt like the recovery flows do; a cancel means
            // "do not start", which must never be treated as a session.
            const rawId = globalThis.prompt?.(
              "Scenario ID (exactly as in TEST_MATRIX, e.g. T00):",
              "T00",
            );
            if (rawId === null || rawId === undefined) return;
            const scenarioId = rawId
              .trim()
              .toUpperCase()
              .replace(/[^A-Z0-9_-]/g, "");
            if (scenarioId.length === 0) return;
            const rawName = globalThis.prompt?.("Short scenario name (optional):", "") ?? "";
            const now = deps.clock.now();
            deps.recorder.startSession(
              createDiagnosticSession({
                id: newSessionId(now, () => deps.random.next()),
                scenarioId,
                scenarioName: rawName.trim(),
                startedAt: now,
                build: deps.build,
              }),
            );
            panel.toast("info", `已开始诊断会话 ${scenarioId}`);
            render();
          },
          finishAndExport: () => {
            // Close the session first so the bundle's manifest carries the
            // final status, then run the same export path as "Export Now".
            deps.recorder.finishSession("completed");
            panel.toast("info", "诊断会话已结束，正在导出证据包…");
            void runExport();
          },
          exportNow: () => {
            panel.toast("info", "正在导出诊断证据包…");
            void runExport();
          },
          copySessionId: () => {
            if (globalThis.navigator?.clipboard) {
              void globalThis.navigator.clipboard.writeText(deps.recorder.sessionId());
              panel.toast("success", "会话 ID 已复制");
            }
          },
          recheckPage: () => {
            panelCallbacks.recheck();
          },
          resetBuffers: () => {
            deps.recorder.resetBuffers();
            panel.toast("info", "已清空诊断记录缓存");
            render();
          },
        },
      );
    }

    panel.render(view);
  };

  controller = createController({
    clock: deps.clock,
    logger: deps.logger,
    // The orchestrator is wrapped so every effect's lifecycle is recorded. The
    // wrapper is transparent: same interface, same behaviour, extra evidence.
    orchestrator: traceOrchestrator(orchestrator, {
      recorder: deps.recorder,
      now: () => deps.clock.now(),
      budgets: DEFAULT_EFFECT_BUDGETS,
    }),
    history,
    watchdog,
    maxRetries: policy.maxRetries,
    // State transitions are traced by wrapping the pure reducer, so the reducer
    // itself keeps no diagnostics dependency.
    reducer: (context, event, reduceOptions) =>
      reduceWithTrace(deps.recorder, {
        context,
        event,
        options: reduceOptions,
        ...(currentPageKind === "unknown" ? {} : { routeId: currentPageKind }),
      }),
    onChange: render,
    onPersist: persist,
  });

  // --- SPA lifecycle ------------------------------------------------------
  const pageObserver = createPageObserver(window);

  let currentPageKind = "unknown";
  let pageEpoch = 0;
  let routeSettleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  /**
   * Re-reads the page classification and repaints.
   *
   * The classification is shown in the panel because a user who cannot tell
   * whether JobPilot recognises the page cannot tell whether it is safe to
   * start it.
   */
  /**
   * Maps a detected page onto a verification kind.
   *
   * Returns undefined for a page JobPilot can work with, so the caller only
   * blocks on a genuine challenge rather than on every unknown layout.
   */
  const verificationKindFor = (kind: string): VerificationKind | undefined => {
    switch (kind) {
      case "captcha":
        return "captcha";
      case "login-required":
        return "login-required";
      case "unknown":
        return "unknown-modal";
      default:
        return undefined;
    }
  };

  const refreshCurrentJob = async (): Promise<void> => {
    try {
      const doc = globalThis.document;
      const detailEl = doc.querySelector(
        ".job-detail-section, .job-banner, [data-jobpilot-detail]",
      );
      if (detailEl) {
        const titleEl = doc.querySelector(".name, .job-title, [data-jobpilot-job-title], h1");
        const title = titleEl?.textContent?.trim() ?? "";
        const companyEl = doc.querySelector(
          ".company-info a, .company-name, [data-jobpilot-company]",
        );
        const companyName = companyEl?.textContent?.trim() ?? "";
        const salaryEl = doc.querySelector(".salary, [data-jobpilot-salary]");
        const salaryRaw = salaryEl?.textContent?.trim() ?? undefined;
        const cityEl = doc.querySelector(".text-city, .job-location, [data-jobpilot-location]");
        const city = cityEl?.textContent?.trim() ?? undefined;
        const descEl = doc.querySelector(".job-sec-text, .job-detail-desc, [data-jobpilot-desc]");
        const description = descEl?.textContent?.trim() ?? "";

        const urlMatch = globalThis.location?.pathname?.match(/\/job_detail\/([^./?#]+)/);
        const dataJobId =
          detailEl.getAttribute("data-job-id") ||
          detailEl.getAttribute("data-jobpilot-job-id") ||
          detailEl.getAttribute("data-jobpilot-id");
        const id = dataJobId || (urlMatch ? urlMatch[1] : undefined);

        if (id && title) {
          const now = deps.clock.now();
          const existing = await workspaceStorage.jobs.getJob(id);
          const benefits = extractBenefits(description);
          const potentialConcerns = extractConcerns(description);

          const merged = mergeJobSnapshot(
            existing,
            {
              id,
              platform: "boss",
              title,
              companyName: companyName || "未知公司",
              salaryRaw,
              city,
              description,
              benefits,
              potentialConcerns,
              canonicalUrl: globalThis.location?.href,
            },
            { now },
          );

          await workspaceStorage.jobs.saveJob(merged);
          currentViewingJob = merged;
          currentViewingAnnotation = await workspaceStorage.annotations.getOrCreateAnnotation(
            id,
            now,
          );
        }
      }
    } catch (err) {
      deps.logger.debug("bootstrap", "current job extraction failed", { err });
    }
  };

  const refreshPageKind = (): void => {
    try {
      const detailed = detectBossDetailedPageKind(globalThis.document, globalThis.location);
      const kind =
        detailed.kind === "login-required"
          ? "login-required"
          : detailed.kind === "human-verification"
            ? "captcha"
            : detailed.kind === "chat"
              ? "chat"
              : deps.platform.detectPage();

      if (kind === currentPageKind) {
        void refreshCurrentJob().then(() => {
          hostEnhancer.refresh();
          render();
        });
        return;
      }
      const previousKind = currentPageKind;
      currentPageKind = kind;
      deps.logger.debug("bootstrap", "page kind", { kind });

      void refreshCurrentJob().then(() => {
        hostEnhancer.refresh();
        render();
      });

      // Emitted here because this is where a route change actually becomes
      // observable: the observer fires on any DOM mutation, and only a change
      // in the classified page represents a real navigation. Nothing emitted
      // this before, so a bundle could not show that the page had moved.
      deps.recorder.record({
        level: "info",
        category: "route",
        event: EVENTS.routeChanged,
        routeId: kind,
        data: { from: previousKind, to: kind },
      });

      // A fingerprint on every classification change. It is what lets a later
      // failure answer "did the layout move?" without anyone re-visiting the
      // page: two runs with the same signature differ behaviourally, two with
      // different signatures differ structurally, and those are different
      // investigations.
      recordPageFingerprint(
        deps.recorder,
        fingerprintPage({
          document: globalThis.document,
          pageKind: kind,
          location: globalThis.location,
          regionSelectors: [
            "[data-jobpilot-list]",
            "[data-jobpilot-card]",
            ".job-detail",
            ".chat-conversation",
            "[role='dialog']",
          ],
        }),
      );

      // Entering a challenge from ANY previous state blocks automation and
      // stops any running work. This is the entry point for the human
      // verification flow; without it the controller would never leave
      // `clear` and the block would only exist in tests.
      const challenge = verificationKindFor(kind);
      if (challenge !== undefined) {
        if (!verification.isBlocked()) {
          verification.block(challenge, deps.clock.now());
          controller?.dispatch({
            type: "PAUSE",
            reason:
              challenge === "captcha"
                ? { kind: "captcha", evidence: "page detected as a CAPTCHA" }
                : challenge === "login-required"
                  ? { kind: "login-expired", evidence: "page detected as a login wall" }
                  : { kind: "unknown-dom", evidence: "page could not be classified" },
          });
          panel.toast("warn", `${VERIFICATION_MESSAGE[challenge]}完成后点「重新检查页面」。`);
        }
      }

      render();
    } catch (error) {
      deps.recorder.errorEvent("bootstrap", "bootstrap.page_detection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Change detection works on a NORMALISED route key: when a list container is
  // present, job-list and job-detail are the same route (a drawer opening over
  // the listing is not navigation — the batch itself opens drawers, and
  // pausing on that flip killed every live run). The key is (URL, normalised
  // kind); it updates on every settle, and PAGE_CHANGED dispatches only when
  // the key actually changes.
  let lastRouteKey: string | undefined;

  pageObserver.onPageChange(() => {
    discoveryEpoch += 1;
    pageEpoch += 1;
    const epoch = pageEpoch;
    if (routeSettleTimer !== undefined) clearTimeout(routeSettleTimer);
    // Give the SPA a moment to render the new route's DOM before re-reading it.
    routeSettleTimer = setTimeout(() => {
      routeSettleTimer = undefined;
      if (disposed || epoch !== pageEpoch) return;
      try {
        const after = deps.platform.detectPage();
        refreshPageKind();
        const href = globalThis.location?.href ?? "";
        const listPresent = globalThis.document?.querySelector(".job-list-container") !== null;
        const normalisedKind =
          listPresent && (after === "job-list" || after === "job-detail") ? "listing" : after;
        const key = `${href}::${normalisedKind}`;
        // First observation establishes the baseline without a spurious event.
        if (lastRouteKey === undefined) {
          lastRouteKey = key;
          return;
        }
        // A URL transition is navigation even when both routes classify to the
        // same kind (one search/list page to another). The reducer explicitly
        // permits only the expected contacting -> chat transition; every other
        // active route change stops the run.
        if (key === lastRouteKey) return;
        lastRouteKey = key;
        controller?.dispatch({ type: "PAGE_CHANGED", pageKind: after });
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
      storage: storageHealth(),
      isQueueOwner: isOwner,
      sessionLimitReached: false,
      hourlyLimitReached: false,
      rateLimited: false,
    };

    const gate = evaluateExecutionGates(base);
    if (!gate.allowed) {
      deps.logger.warn("bootstrap", "recovered transaction left unresolved by a gate", {
        jobId: recovered.jobId,
        reason: gate.reason,
      });
      panel.toast(
        "warn",
        `可能已向 ${recovered.jobId} 发送过消息。JobPilot 不会自动核查：${gate.message ?? "安全门正在阻止"}。`,
      );
      return;
    }

    if (!isSendCommitted(recovered)) {
      // Nothing was clicked, so there is nothing to verify. Clearing the record
      // is the whole action, and it is not a send.
      deps.logger.info("bootstrap", "discarding an uncommitted transaction", {
        jobId: recovered.jobId,
        phase: recovered.phase,
      });
      await communicationService.discardRecovered();
      return;
    }

    if (recovered.phase === "uncertain") {
      panel.toast(
        "warn",
        "上次发送结果仍不确定。JobPilot 已保留记录且不会再次发送，请先人工确认对话。",
      );
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
        ? "已确认：之前的消息发送成功。"
        : "可能已发送过消息。请打开对话确认，JobPilot 不会重复发送。",
    );
  };

  if (pendingIntent !== undefined) {
    void ensureOwnership().then(async (owned) => {
      if (!owned) {
        panel.toast(
          "warn",
          "检测到上次未完成的沟通记录，但另一个标签页正在运行。JobPilot 不会发送，请在该标签页完成核查。",
        );
        return;
      }
      try {
        await settleRecoveredTransaction();
      } finally {
        // Recovery is observation/cleanup only and never owns a running batch.
        releaseOwnership();
      }
    });
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
      disposed = true;
      startRequestEpoch += 1;
      pageEpoch += 1;
      if (routeSettleTimer !== undefined) clearTimeout(routeSettleTimer);
      routeSettleTimer = undefined;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (isOwner) void lock.release(ownerId);
      pageObserver.dispose();
      hostEnhancer.dispose();
      void workspaceStorage.close();
      controller?.dispose();
      watchdog.reset();
      watchdog.stop();
      panel.dispose();
      controller = undefined;
    },
  };
};

export { bootstrapWith };
