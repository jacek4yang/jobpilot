/**
 * Pipeline Page Renderer.
 *
 * Tracks job applications through recruitment stages:
 * 刚发现 -> 喜欢 -> 准备沟通 -> 已沟通 -> 有回复 -> 待面试 -> 已面试 -> 收到 Offer -> 已结束
 */

import {
  type InterviewRecord,
  type JobStage,
  PIPELINE_STAGES,
  type PipelineRecord,
  STAGE_LABELS,
  type StoredJob,
} from "../../domain/workspace/types";
import { el } from "../components/chips";
import { t } from "../i18n";
import type { UiCallbacks } from "../view-model";

export interface PipelinePageInput {
  readonly jobs: readonly StoredJob[];
  readonly pipelineRecords: readonly PipelineRecord[];
  readonly interviews: readonly InterviewRecord[];
  readonly callbacks: UiCallbacks;
}

export const renderPipelinePage = (doc: Document, input: PipelinePageInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-pipeline");

  // Map jobs by id for quick resolution
  const jobMap = new Map<string, StoredJob>();
  for (const j of input.jobs) {
    jobMap.set(j.id, j);
  }

  const interviewMap = new Map<string, InterviewRecord>();
  for (const int of input.interviews) {
    interviewMap.set(int.jobId, int);
  }

  // Count per stage
  const counts: Record<string, number> = {};
  for (const s of PIPELINE_STAGES) {
    counts[s] = 0;
  }
  for (const r of input.pipelineRecords) {
    const current = counts[r.stage] ?? 0;
    counts[r.stage] = current + 1;
  }

  // Stage Summary Bar
  const summaryGrid = el(doc, "div", "jobpilot-stage-grid");
  let activeStage: JobStage = "ready-to-contact";

  const stageButtons = new Map<JobStage, HTMLElement>();
  const cardContainer = el(doc, "div", "jobpilot-stage-cards");

  const renderStageJobs = (stage: JobStage): void => {
    cardContainer.innerHTML = "";
    const filteredRecords = input.pipelineRecords.filter((r) => r.stage === stage);

    if (filteredRecords.length === 0) {
      const empty = el(doc, "div", "jobpilot-card");
      empty.append(el(doc, "div", "jobpilot-empty-desc", t("pipeline.emptyStage")));
      cardContainer.append(empty);
      return;
    }

    for (const record of filteredRecords) {
      const job = jobMap.get(record.jobId);
      if (!job) continue;

      const card = el(doc, "div", "jobpilot-card");
      const titleRow = el(doc, "div", "jobpilot-row");
      titleRow.append(
        el(doc, "span", "jobpilot-card-title", job.title),
        el(doc, "span", "jobpilot-job-salary", job.salaryRaw ?? ""),
      );

      const meta = el(
        doc,
        "div",
        "jobpilot-job-meta",
        `${job.companyName} · ${job.city ?? job.locationRaw ?? ""}`,
      );

      card.append(titleRow, meta);

      // Interview block if present
      const interview = interviewMap.get(record.jobId);
      if (interview?.scheduledAt) {
        const intBlock = el(doc, "div", "jobpilot-interview-badge");
        const dateStr = new Date(interview.scheduledAt).toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        intBlock.textContent = `📅 面试: ${dateStr} (${interview.location ?? "线上"})`;
        card.append(intBlock);
      }

      // Stage mover row
      const actionRow = el(doc, "div", "jobpilot-row");
      actionRow.style.marginTop = "8px";

      const select = el(doc, "select", "jobpilot-select") as HTMLSelectElement;
      for (const s of PIPELINE_STAGES) {
        const opt = doc.createElement("option");
        opt.value = s;
        opt.textContent = STAGE_LABELS[s];
        if (s === record.stage) opt.selected = true;
        select.append(opt);
      }

      select.addEventListener("change", () => {
        input.callbacks.onSetPipelineStage?.(record.jobId, select.value as JobStage);
      });

      // Quick Add Interview button
      const addIntBtn = el(
        doc,
        "button",
        "jobpilot-btn jobpilot-btn-sm",
        interview ? "修改面试" : "+ 面试",
      ) as HTMLButtonElement;
      addIntBtn.type = "button";
      addIntBtn.addEventListener("click", () => {
        const promptTime = prompt("输入面试时间 (格式: 2026-09-25 14:00):", "");
        if (promptTime) {
          const ts = new Date(promptTime).getTime();
          if (!Number.isNaN(ts)) {
            input.callbacks.onSaveInterview?.({
              id: interview?.id ?? `int_${Date.now()}`,
              jobId: record.jobId,
              scheduledAt: ts,
              format: "online",
              location: "线上会议",
              notes: "准备自我介绍",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
            input.callbacks.onSetPipelineStage?.(record.jobId, "interview-planned");
          }
        }
      });

      actionRow.append(select, addIntBtn);
      card.append(actionRow);

      cardContainer.append(card);
    }
  };

  for (const s of PIPELINE_STAGES.slice(0, 7)) {
    const tile = el(doc, "div", "jobpilot-stage-tile");
    if (s === activeStage) tile.classList.add("jobpilot-stage-tile-active");

    const label = el(doc, "div", "jobpilot-stage-name", STAGE_LABELS[s]);
    const count = el(doc, "div", "jobpilot-stage-count", String(counts[s] ?? 0));

    tile.append(label, count);
    tile.addEventListener("click", () => {
      activeStage = s;
      for (const [stageKey, btn] of stageButtons) {
        btn.classList.toggle("jobpilot-stage-tile-active", stageKey === activeStage);
      }
      renderStageJobs(activeStage);
    });

    summaryGrid.append(tile);
    stageButtons.set(s, tile);
  }

  container.append(summaryGrid, cardContainer);
  renderStageJobs(activeStage);

  return container;
};
