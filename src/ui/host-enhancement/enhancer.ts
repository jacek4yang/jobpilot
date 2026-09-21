/**
 * Non-invasive BOSS host page enhancer.
 *
 * Enriches BOSS native cards with subtle JobPilot indicators:
 * - Badges for personal preference (e.g. 💗 喜欢), stage (已沟通), or notes
 * - Detail page anchor to open JobPilot companion
 *
 * Strict Invariants:
 * - Never modifies, hides, or moves original BOSS controls or content.
 * - Completely reversible: `dispose()` cleans up all injected DOM, observers, and listeners.
 */

import type { JobStage, PersonalPreference } from "../../domain/workspace/types";

export interface HostJobBadgeData {
  readonly preference?: PersonalPreference | undefined;
  readonly stage?: JobStage | undefined;
  readonly hasNote?: boolean | undefined;
  readonly score?: number | undefined;
}

export interface HostEnhancerDeps {
  readonly document: Document;
  readonly getBadgeData: (jobId: string) => Promise<HostJobBadgeData | undefined>;
  readonly onOpenJobSummary?: ((jobId: string) => void) | undefined;
}

export interface HostEnhancer {
  start(): void;
  refresh(): void;
  dispose(): void;
}

const HOST_STYLE_ID = "jobpilot-host-styles";

const HOST_CSS = `
.jobpilot-host-badge-container {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  vertical-align: middle;
}
.jobpilot-host-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  white-space: nowrap;
}
.jobpilot-host-badge-fav {
  background: #FFF0F2;
  color: #D86B85;
  border: 1px solid #F5C6D0;
}
.jobpilot-host-badge-contacted {
  background: #F0F9F4;
  color: #2E8B57;
  border: 1px solid #C8E8D5;
}
.jobpilot-host-badge-noted {
  background: #F6F4FE;
  color: #6B52B8;
  border: 1px solid #DFDAF7;
}
.jobpilot-host-badge-score {
  background: #FDF4EB;
  color: #B26A1B;
  border: 1px solid #F6DFCE;
}
.jobpilot-host-summary-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #D86B85;
  background: #FFF0F2;
  border: 1px solid #F5C6D0;
  border-radius: 6px;
  cursor: pointer;
  margin-left: 12px;
  transition: all 0.2s ease;
}
.jobpilot-host-summary-btn:hover {
  background: #FCE6EA;
}
`;

export const createHostEnhancer = (deps: HostEnhancerDeps): HostEnhancer => {
  const doc = deps.document;
  let observer: MutationObserver | null = null;
  let isRunning = false;

  const ensureStyles = (): void => {
    if (doc.getElementById(HOST_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = HOST_STYLE_ID;
    style.textContent = HOST_CSS;
    (doc.head || doc.documentElement).append(style);
  };

  const removeStyles = (): void => {
    doc.getElementById(HOST_STYLE_ID)?.remove();
  };

  const extractJobIdFromCard = (card: Element): string | null => {
    const attrId =
      card.getAttribute("data-job-id") ||
      card.getAttribute("data-jobid") ||
      card.getAttribute("data-jobpilot-card");
    if (attrId && attrId !== "true") return attrId;

    const link = card.querySelector("a[href*='/job_detail/']");
    if (link) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/job_detail\/([^./?#]+)/);
      if (match?.[1]) return match[1];
    }
    return null;
  };

  const enhanceCard = async (card: Element): Promise<void> => {
    if (card.hasAttribute("data-jobpilot-enhanced")) return;
    const jobId = extractJobIdFromCard(card);
    if (!jobId) return;

    const data = await deps.getBadgeData(jobId);
    if (!data) return;

    card.setAttribute("data-jobpilot-enhanced", "true");

    // Avoid duplicate container
    if (card.querySelector(".jobpilot-host-badge-container")) return;

    const container = doc.createElement("span");
    container.className = "jobpilot-host-badge-container";
    container.setAttribute("data-jobpilot-badge-container", "true");

    if (data.preference === "favorite" || data.preference === "interested") {
      const badge = doc.createElement("span");
      badge.className = "jobpilot-host-badge jobpilot-host-badge-fav";
      badge.textContent = data.preference === "favorite" ? "💗 喜欢" : "🩷 有兴趣";
      container.append(badge);
    }

    if (data.stage === "contacted" || data.stage === "replied") {
      const badge = doc.createElement("span");
      badge.className = "jobpilot-host-badge jobpilot-host-badge-contacted";
      badge.textContent = data.stage === "contacted" ? "已沟通" : "有回复";
      container.append(badge);
    }

    if (data.hasNote) {
      const badge = doc.createElement("span");
      badge.className = "jobpilot-host-badge jobpilot-host-badge-noted";
      badge.textContent = "有备注";
      container.append(badge);
    }

    if (typeof data.score === "number" && data.score > 0) {
      const badge = doc.createElement("span");
      badge.className = "jobpilot-host-badge jobpilot-host-badge-score";
      badge.textContent = `匹配 ${data.score}`;
      container.append(badge);
    }

    if (container.children.length > 0) {
      const titleEl =
        card.querySelector(".job-name, .job-title, [data-jobpilot-field='title']") || card;
      titleEl.append(container);
    }
  };

  const enhanceDetailPage = (): void => {
    const detailBox = doc.querySelector(".job-detail-box, [data-jobpilot-detail]");
    if (!detailBox || detailBox.querySelector(".jobpilot-host-summary-btn")) return;

    const titleEl = detailBox.querySelector(".name, h1, [data-jobpilot-field='title']");
    if (!titleEl) return;

    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "jobpilot-host-summary-btn";
    btn.setAttribute("data-jobpilot-summary-trigger", "true");
    btn.textContent = "✨ JobPilot 摘要";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      deps.onOpenJobSummary?.("current");
    });

    titleEl.append(btn);
  };

  const scan = (): void => {
    if (!isRunning) return;
    ensureStyles();

    const cards = doc.querySelectorAll(".job-card-wrapper, .job-card-box, [data-jobpilot-card]");
    for (const card of Array.from(cards)) {
      void enhanceCard(card);
    }

    enhanceDetailPage();
  };

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      ensureStyles();
      scan();

      const MutationObserverClass =
        doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;

      if (MutationObserverClass) {
        observer = new MutationObserverClass(() => {
          scan();
        });

        observer.observe(doc.body, {
          childList: true,
          subtree: true,
        });
      }
    },

    refresh() {
      // Re-scan cards and detail page
      scan();
    },

    dispose() {
      isRunning = false;
      if (observer) {
        observer.disconnect();
        observer = null;
      }

      // Completely remove all injected badges, containers, and buttons
      const injected = doc.querySelectorAll(
        "[data-jobpilot-badge-container], [data-jobpilot-summary-trigger]",
      );
      for (const el of Array.from(injected)) {
        el.remove();
      }

      // Remove enhancement flags on cards
      const enhancedCards = doc.querySelectorAll("[data-jobpilot-enhanced]");
      for (const card of Array.from(enhancedCards)) {
        card.removeAttribute("data-jobpilot-enhanced");
      }

      removeStyles();
    },
  };
};
