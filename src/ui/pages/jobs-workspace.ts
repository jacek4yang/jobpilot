/**
 * Personal Job Workspace Page Renderer.
 *
 * Provides:
 * 1. Current Job Companion (正在看) with benefits, concerns, feelings, notes autosave, questions.
 * 2. Favorites list (喜欢) and Considering list (再看看).
 * 3. Side-by-side Job Comparison (对比).
 * 4. Saved Jobs Archive (全部已存).
 */

import {
  BUILTIN_QUESTION_TAGS,
  type CustomTag,
  type JobAnnotation,
  type PersonalPreference,
  PREFERENCE_LABELS,
  type QuestionItem,
  type StoredJob,
} from "../../domain/workspace/types";
import { el } from "../components/chips";
import { t } from "../i18n";
import type { UiCallbacks } from "../view-model";

/**
 * The active workspace subtab, kept at module scope on purpose. The panel is
 * fully re-rendered whenever any async state update lands (storage reads,
 * badge data, annotations), and a re-render re-invokes this function with a
 * fresh closure — an `activeSubTab` local would silently reset the user's
 * place. Module scope survives re-renders within the page lifetime; a full
 * page reload resets to the default, which is the desired behaviour.
 */
let persistedActiveSubTab: string | null = null;

export interface JobsWorkspaceInput {
  readonly currentJob?: StoredJob | undefined;
  readonly currentAnnotation?: JobAnnotation | undefined;
  readonly allJobs: readonly StoredJob[];
  readonly allAnnotations: readonly JobAnnotation[];
  readonly customTags: readonly CustomTag[];
  readonly callbacks: UiCallbacks;
}

export const renderJobsWorkspacePage = (doc: Document, input: JobsWorkspaceInput): HTMLElement => {
  const container = el(doc, "div", "jobpilot-page-workspace");

  // --- Sub-navigation Tabs ------------------------------------------------
  const subNav = el(doc, "div", "jobpilot-subnav");
  const subTabs: Array<{ id: string; label: string }> = [
    { id: "current", label: t("workspace.tabCurrent") },
    { id: "favorites", label: t("workspace.tabFavorites") },
    { id: "considering", label: t("workspace.tabConsidering") },
    { id: "compare", label: t("workspace.tabCompare") },
    { id: "archive", label: t("workspace.tabArchive") },
  ];

  let activeSubTab =
    persistedActiveSubTab ?? (input.currentJob ? "current" : "favorites");
  const views = new Map<string, HTMLElement>();
  const buttons = new Map<string, HTMLButtonElement>();

  for (const tab of subTabs) {
    const btn = el(doc, "button", "jobpilot-subnav-btn", tab.label) as HTMLButtonElement;
    btn.type = "button";
    btn.setAttribute("data-subtab", tab.id);
    if (tab.id === activeSubTab) btn.classList.add("jobpilot-subnav-btn-active");
    btn.addEventListener("click", () => {
      activeSubTab = tab.id;
      persistedActiveSubTab = tab.id;
      for (const [id, b] of buttons) {
        b.classList.toggle("jobpilot-subnav-btn-active", id === activeSubTab);
      }
      for (const [id, v] of views) {
        v.style.display = id === activeSubTab ? "block" : "none";
      }
    });
    subNav.append(btn);
    buttons.set(tab.id, btn);
  }

  container.append(subNav);

  // Helper map for fast lookup
  const annotationMap = new Map<string, JobAnnotation>();
  for (const a of input.allAnnotations) {
    annotationMap.set(a.jobId, a);
  }

  // Selected comparison job IDs
  const compareJobIds = new Set<string>();

  // =========================================================================
  // View 1: 正在看 (Current Job Companion)
  // =========================================================================
  const currentView = el(doc, "div", "jobpilot-subview");
  views.set("current", currentView);

  if (!input.currentJob) {
    const emptyCard = el(doc, "div", "jobpilot-card");
    const emptyTitle = el(doc, "div", "jobpilot-empty-title", t("workspace.currentTitle"));
    const emptyText = el(doc, "div", "jobpilot-empty-desc", t("workspace.noCurrent"));
    emptyCard.append(emptyTitle, emptyText);
    currentView.append(emptyCard);
  } else {
    const job = input.currentJob;
    const ann = input.currentAnnotation ?? {
      jobId: job.id,
      preference: "unset",
      positiveTags: [],
      concernTags: [],
      questionTags: [],
      customTags: [],
      questions: [],
      pinned: false,
      updatedAt: Date.now(),
    };

    // Header Card
    const headerCard = el(doc, "div", "jobpilot-card");
    const titleRow = el(doc, "div", "jobpilot-row");
    const title = el(doc, "h3", "jobpilot-job-title", job.title);
    title.style.margin = "0";
    const salary = el(doc, "span", "jobpilot-job-salary", job.salaryRaw ?? "面议");
    titleRow.append(title, salary);

    const metaRow = el(
      doc,
      "div",
      "jobpilot-job-meta",
      `${job.companyName} · ${job.locationRaw ?? job.city ?? "地点待定"} · ${
        job.experience ?? "经验不限"
      } · ${job.education ?? "学历不限"}`,
    );

    headerCard.append(titleRow, metaRow);

    // Feeling / Preference Buttons
    const feelingSection = el(doc, "div", "jobpilot-section-block");
    const feelingTitle = el(doc, "div", "jobpilot-section-label", t("workspace.myFeeling"));
    const feelingRow = el(doc, "div", "jobpilot-tag-row");

    const preferences: PersonalPreference[] = ["favorite", "interested", "maybe", "not-interested"];

    for (const pref of preferences) {
      const prefBtn = el(
        doc,
        "button",
        "jobpilot-pref-btn",
        PREFERENCE_LABELS[pref],
      ) as HTMLButtonElement;
      prefBtn.type = "button";
      if (ann.preference === pref) {
        prefBtn.classList.add("jobpilot-pref-btn-active");
      }
      prefBtn.addEventListener("click", () => {
        const next = ann.preference === pref ? "unset" : pref;
        input.callbacks.onSetPreference?.(job.id, next);
        if (next === "favorite") {
          input.callbacks.onSetPipelineStage?.(job.id, "favorite");
        }
      });
      feelingRow.append(prefBtn);
    }
    feelingSection.append(feelingTitle, feelingRow);
    headerCard.append(feelingSection);

    // Benefits Section
    const benefits = job.benefits ?? [];
    if (benefits.length > 0) {
      const benSection = el(doc, "div", "jobpilot-section-block");
      const benTitle = el(
        doc,
        "div",
        "jobpilot-section-label",
        `✨ ${t("workspace.benefitsTitle")}`,
      );
      const benRow = el(doc, "div", "jobpilot-tag-row");
      for (const b of benefits) {
        const chip = el(doc, "span", "jobpilot-chip jobpilot-chip-success", `✓ ${b}`);
        benRow.append(chip);
      }
      benSection.append(benTitle, benRow);
      headerCard.append(benSection);
    }

    // Concerns Section
    const concerns = job.potentialConcerns ?? [];
    if (concerns.length > 0) {
      const conSection = el(doc, "div", "jobpilot-section-block");
      const conTitle = el(
        doc,
        "div",
        "jobpilot-section-label",
        `💡 ${t("workspace.concernsTitle")}`,
      );
      conSection.append(conTitle);
      for (const c of concerns) {
        const reminder = el(doc, "div", "jobpilot-concern-reminder", `⚠ ${c}`);
        conSection.append(reminder);
      }
      headerCard.append(conSection);
    }

    currentView.append(headerCard);

    // Notes Card with Debounced Autosave
    const noteCard = el(doc, "div", "jobpilot-card");
    const noteHeader = el(doc, "div", "jobpilot-row");
    const noteTitle = el(doc, "div", "jobpilot-section-label", `📝 ${t("workspace.noteTitle")}`);
    const noteFeedback = el(doc, "span", "jobpilot-saved-hint", "");
    noteHeader.append(noteTitle, noteFeedback);

    const textarea = el(doc, "textarea", "jobpilot-textarea") as HTMLTextAreaElement;
    textarea.rows = 3;
    textarea.placeholder = t("workspace.notePlaceholder");
    textarea.value = ann.note ?? "";

    let timer: ReturnType<typeof setTimeout> | undefined;
    textarea.addEventListener("input", () => {
      noteFeedback.textContent = "";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        input.callbacks.onSaveNote?.(job.id, textarea.value);
        noteFeedback.textContent = t("workspace.noteSaved");
        setTimeout(() => {
          noteFeedback.textContent = "";
        }, 2500);
      }, 600);
    });

    noteCard.append(noteHeader, textarea);
    currentView.append(noteCard);

    // Questions Checklist Card
    const qCard = el(doc, "div", "jobpilot-card");
    const qTitle = el(doc, "div", "jobpilot-section-label", `❓ ${t("workspace.questionsTitle")}`);
    const qList = el(doc, "div", "jobpilot-checklist");

    const currentQuestions =
      ann.questions && ann.questions.length > 0
        ? ann.questions
        : BUILTIN_QUESTION_TAGS.slice(0, 4).map((text, idx) => ({
            id: `q_${idx}`,
            text,
            answered: false,
          }));

    const renderQuestions = (items: readonly QuestionItem[]): void => {
      qList.innerHTML = "";
      for (const q of items) {
        const row = el(doc, "label", "jobpilot-check-item");
        const checkbox = el(doc, "input") as HTMLInputElement;
        checkbox.type = "checkbox";
        checkbox.checked = q.answered;
        checkbox.addEventListener("change", () => {
          const updated = items.map((item) =>
            item.id === q.id ? { ...item, answered: checkbox.checked } : item,
          );
          input.callbacks.onUpdateQuestions?.(job.id, updated);
        });

        const span = el(
          doc,
          "span",
          q.answered ? "jobpilot-item-text jobpilot-answered" : "jobpilot-item-text",
          q.text,
        );
        row.append(checkbox, span);
        qList.append(row);
      }
    };

    renderQuestions(currentQuestions);

    const addQRow = el(doc, "div", "jobpilot-row");
    addQRow.style.marginTop = "8px";
    const qInput = el(doc, "input", "jobpilot-input") as HTMLInputElement;
    qInput.placeholder = t("workspace.addQuestionPlaceholder");
    qInput.style.flex = "1";
    const addQBtn = el(
      doc,
      "button",
      "jobpilot-btn",
      t("workspace.addQuestionBtn"),
    ) as HTMLButtonElement;
    addQBtn.type = "button";
    addQBtn.addEventListener("click", () => {
      const val = qInput.value.trim();
      if (!val) return;
      const newQ: QuestionItem = {
        id: `q_${Date.now()}`,
        text: val,
        answered: false,
      };
      const next = [...currentQuestions, newQ];
      input.callbacks.onUpdateQuestions?.(job.id, next);
      qInput.value = "";
      renderQuestions(next);
    });

    addQRow.append(qInput, addQBtn);
    qCard.append(qTitle, qList, addQRow);
    currentView.append(qCard);
  }

  // =========================================================================
  // View 2: 喜欢 (Favorites)
  // =========================================================================
  const favView = el(doc, "div", "jobpilot-subview");
  views.set("favorites", favView);

  const favJobs = input.allJobs.filter((j) => {
    const a = annotationMap.get(j.id);
    return a?.preference === "favorite" || a?.preference === "interested";
  });

  if (favJobs.length === 0) {
    const emptyCard = el(doc, "div", "jobpilot-card");
    emptyCard.append(el(doc, "div", "jobpilot-empty-desc", t("workspace.emptyFavorites")));
    favView.append(emptyCard);
  } else {
    for (const job of favJobs) {
      const ann = annotationMap.get(job.id);
      const card = el(doc, "div", "jobpilot-card");

      const row1 = el(doc, "div", "jobpilot-row");
      const title = el(doc, "span", "jobpilot-card-title", job.title);
      const salary = el(doc, "span", "jobpilot-job-salary", job.salaryRaw ?? "");
      row1.append(title, salary);

      const meta = el(
        doc,
        "div",
        "jobpilot-job-meta",
        `${job.companyName} · ${job.city ?? job.locationRaw ?? ""} · ${job.experience ?? ""}`,
      );

      card.append(row1, meta);

      if (ann?.note) {
        const noteRow = el(doc, "div", "jobpilot-card-note", `💬 ${ann.note}`);
        card.append(noteRow);
      }

      const actionsRow = el(doc, "div", "jobpilot-card-actions");

      // Compare checkbox
      const compareLabel = el(doc, "label", "jobpilot-compare-check");
      const check = el(doc, "input") as HTMLInputElement;
      check.type = "checkbox";
      check.checked = compareJobIds.has(job.id);
      check.addEventListener("change", () => {
        if (check.checked) {
          compareJobIds.add(job.id);
        } else {
          compareJobIds.delete(job.id);
        }
        renderCompareTable();
      });
      compareLabel.append(check, doc.createTextNode(` ${t("workspace.addToCompare")}`));

      // Move to Ready-to-contact button
      const contactBtn = el(
        doc,
        "button",
        "jobpilot-btn jobpilot-btn-sm",
        t("workspace.readyToContactBtn"),
      ) as HTMLButtonElement;
      contactBtn.type = "button";
      contactBtn.addEventListener("click", () => {
        input.callbacks.onSetPipelineStage?.(job.id, "ready-to-contact");
        contactBtn.textContent = t("workspace.alreadyInPipeline");
        contactBtn.disabled = true;
      });

      actionsRow.append(compareLabel, contactBtn);
      card.append(actionsRow);

      favView.append(card);
    }
  }

  // =========================================================================
  // View 3: 再看看 (Considering)
  // =========================================================================
  const conView = el(doc, "div", "jobpilot-subview");
  views.set("considering", conView);

  const maybeJobs = input.allJobs.filter((j) => {
    const a = annotationMap.get(j.id);
    return a?.preference === "maybe";
  });

  if (maybeJobs.length === 0) {
    const emptyCard = el(doc, "div", "jobpilot-card");
    emptyCard.append(el(doc, "div", "jobpilot-empty-desc", t("workspace.emptyConsidering")));
    conView.append(emptyCard);
  } else {
    for (const job of maybeJobs) {
      const card = el(doc, "div", "jobpilot-card");
      const row = el(doc, "div", "jobpilot-row");
      row.append(
        el(doc, "span", "jobpilot-card-title", job.title),
        el(doc, "span", "jobpilot-job-salary", job.salaryRaw ?? ""),
      );
      const meta = el(
        doc,
        "div",
        "jobpilot-job-meta",
        `${job.companyName} · ${job.locationRaw ?? ""}`,
      );
      card.append(row, meta);
      conView.append(card);
    }
  }

  // =========================================================================
  // View 4: 对比 (Compare)
  // =========================================================================
  const compView = el(doc, "div", "jobpilot-subview");
  views.set("compare", compView);

  const compContainer = el(doc, "div", "jobpilot-compare-container");
  const renderCompareTable = (): void => {
    compContainer.innerHTML = "";

    const selectedJobs = input.allJobs.filter((j) => compareJobIds.has(j.id));
    if (selectedJobs.length < 2) {
      const card = el(doc, "div", "jobpilot-card");
      card.append(el(doc, "div", "jobpilot-empty-desc", t("workspace.compareSelectHint")));
      compContainer.append(card);
      return;
    }

    const hint = el(doc, "div", "jobpilot-compare-hint", `ℹ️ ${t("workspace.compareHint")}`);
    compContainer.append(hint);

    const tableWrapper = el(doc, "div", "jobpilot-table-wrapper");
    const table = el(doc, "table", "jobpilot-compare-table");

    const dimensions: Array<{ label: string; render: (j: StoredJob) => string }> = [
      { label: "职位", render: (j) => j.title },
      { label: "公司", render: (j) => j.companyName },
      { label: "薪资", render: (j) => j.salaryRaw ?? "面议" },
      { label: "地点", render: (j) => j.locationRaw ?? j.city ?? "未提供" },
      { label: "经验要求", render: (j) => j.experience ?? "不限" },
      { label: "学历要求", render: (j) => j.education ?? "不限" },
      {
        label: "亮点福利",
        render: (j) => (j.benefits && j.benefits.length > 0 ? j.benefits.join("、") : "未提及"),
      },
      {
        label: "需要确认",
        render: (j) =>
          j.potentialConcerns && j.potentialConcerns.length > 0
            ? j.potentialConcerns.join("；")
            : "无特别项",
      },
      {
        label: "我的感觉",
        render: (j) => {
          const ann = annotationMap.get(j.id);
          return ann ? PREFERENCE_LABELS[ann.preference] : "未标记";
        },
      },
      {
        label: "我的备注",
        render: (j) => {
          const ann = annotationMap.get(j.id);
          return ann?.note ?? "暂无";
        },
      },
    ];

    for (const dim of dimensions) {
      const tr = el(doc, "tr");
      const th = el(doc, "th", undefined, dim.label);
      tr.append(th);

      for (const j of selectedJobs) {
        const td = el(doc, "td", undefined, dim.render(j));
        tr.append(td);
      }
      table.append(tr);
    }

    tableWrapper.append(table);
    compContainer.append(tableWrapper);
  };

  renderCompareTable();
  compView.append(compContainer);

  // =========================================================================
  // View 5: 全部职位 (Archive)
  // =========================================================================
  const arcView = el(doc, "div", "jobpilot-subview");
  views.set("archive", arcView);

  if (input.allJobs.length === 0) {
    const emptyCard = el(doc, "div", "jobpilot-card");
    emptyCard.append(el(doc, "div", "jobpilot-empty-desc", t("workspace.emptyArchive")));
    arcView.append(emptyCard);
  } else {
    for (const job of input.allJobs.slice(0, 30)) {
      const card = el(doc, "div", "jobpilot-card");
      const row = el(doc, "div", "jobpilot-row");
      row.append(
        el(doc, "span", "jobpilot-card-title", job.title),
        el(doc, "span", "jobpilot-job-salary", job.salaryRaw ?? ""),
      );
      const meta = el(doc, "div", "jobpilot-job-meta", `${job.companyName} · ${job.city ?? ""}`);
      card.append(row, meta);
      arcView.append(card);
    }
  }

  // Set initial visibility
  for (const [id, v] of views) {
    v.style.display = id === activeSubTab ? "block" : "none";
    container.append(v);
  }

  return container;
};
