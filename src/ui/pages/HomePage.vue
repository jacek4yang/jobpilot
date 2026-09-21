<template>
  <div class="jobpilot-page-home">
    <div v-if="loginRequired" class="jobpilot-login-card" role="region" :aria-label="t('login.title')">
      <div class="jobpilot-login-header">
        <span class="jobpilot-login-icon">👋</span>
        <h3 class="jobpilot-login-title">{{ t("login.title") }}</h3>
      </div>
      <p class="jobpilot-login-desc">{{ t("login.desc") }}</p>
      <div class="jobpilot-login-actions">
        <button type="button" class="jobpilot-btn" data-action="login-confirm" data-variant="primary" @click="callbacks.recheck()">
          {{ t("login.confirmBtn") }}
        </button>
      </div>
    </div>

    <div v-if="blocked" class="jobpilot-blocked-card" role="alert">
      <h3 class="jobpilot-blocked-title">{{ verificationBlock ? t("blocked.verificationTitle") : blocked.reason }}</h3>
      <div class="jobpilot-blocked-body">{{ verificationBlock ? t("blocked.verificationBody") : blocked.body }}</div>
      <div class="jobpilot-blocked-actions">
        <button type="button" class="jobpilot-btn" data-action="recheck" data-variant="primary" @click="callbacks.recheck()">
          {{ t("blocked.recheckButton") }}
        </button>
        <button type="button" class="jobpilot-btn" data-variant="danger" @click="callbacks.stop()">
          {{ t("blocked.stopButton") }}
        </button>
      </div>
    </div>
    <div v-else-if="message" class="jobpilot-card" :style="messageStyle">
      <p style="margin: 0">{{ message.text }}</p>
    </div>

    <div v-if="decisions.length > 0" class="jobpilot-section">
      <span class="jobpilot-section-title">{{ t("decisions.title") }}</span>
      <div v-for="(decision, decisionIndex) in decisions" :key="`${decision.title}-${decisionIndex}`" class="jobpilot-decision-card">
        <div class="jobpilot-decision-title">{{ decision.title }}</div>
        <div class="jobpilot-decision-message">{{ decision.message }}</div>
        <div class="jobpilot-decision-actions">
          <button
            v-for="action in decision.actions"
            :key="action.id"
            type="button"
            class="jobpilot-btn"
            :data-variant="action.id === 'skip' ? 'subtle' : undefined"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="jobpilot-section">
      <span class="jobpilot-section-title">{{ t("home.stepsTitle") }}</span>

      <div class="jobpilot-card">
        <StepHeading number="①" :title="t('home.step1Title')" />
        <p class="jobpilot-step-hint" :style="hintStyle">{{ t("home.step1Hint") }}</p>
        <button
          type="button"
          class="jobpilot-btn"
          data-action="discover-jobs"
          data-variant="primary"
          :disabled="running === true || paused === true"
          @click="callbacks.discover()"
        >
          {{ t("home.step1Button") }}
        </button>
        <p v-if="discoveryNote" class="jobpilot-step-note" style="margin: 8px 0 0; color: var(--jp-text-secondary)">
          {{ discoveryNote }}
        </p>
      </div>

      <div v-if="visibleMatches.length > 0" class="jobpilot-card" style="margin-top: 8px">
        <StepHeading number="②" :title="t('home.step2Title')" />
        <div class="jobpilot-step-match-list" :style="matchListStyle">
          <label
            v-for="match in visibleMatches"
            :key="match.jobId"
            class="jobpilot-step-match-row"
            style="display: flex; align-items: center; gap: 6px; font-size: 13px"
          >
            <input
              type="checkbox"
              :checked="match.selected"
              :data-job-id="match.jobId"
              @change="callbacks.onToggleMatchSelect?.(match.jobId)"
            />
            <span>{{ match.title }} · {{ match.company }} · {{ match.score }}分</span>
          </label>
        </div>
        <p class="jobpilot-step-hint" style="margin: 8px 0 0; color: var(--jp-text-secondary)">{{ t("home.step2Hint") }}</p>
      </div>

      <div class="jobpilot-card" style="margin-top: 8px">
        <StepHeading number="③" :title="t('home.step3Title')" />
        <p class="jobpilot-step-count" :style="hintStyle">
          {{ t("home.step3Selected", { count: effectiveSelectedCount }) }}
        </p>
        <div class="jobpilot-step-actions" style="display: flex; flex-wrap: wrap; gap: 6px">
          <button type="button" class="jobpilot-btn" data-action="start-batch" data-variant="primary" :disabled="effectiveSelectedCount === 0 || running === true || paused === true" @click="callbacks.start()">
            {{ t("home.step3Start") }}
          </button>
          <button type="button" class="jobpilot-btn" data-action="pause-batch" :disabled="running !== true" @click="callbacks.pause()">{{ t("common.pause") }}</button>
          <button type="button" class="jobpilot-btn" data-action="resume-batch" :disabled="paused !== true" @click="callbacks.resume()">{{ t("common.resume") }}</button>
          <button type="button" class="jobpilot-btn" data-action="stop-batch" data-variant="danger" :disabled="running !== true && paused !== true" @click="callbacks.stop()">{{ t("common.stop") }}</button>
        </div>
        <p class="jobpilot-step-hint" style="margin: 8px 0 0; color: var(--jp-text-secondary)">{{ t("home.step3Hint") }}</p>
      </div>

      <div v-if="runLog && runLog.length > 0" class="jobpilot-card" style="margin-top: 8px">
        <div class="jobpilot-step-title">{{ t("home.runLogTitle") }}</div>
        <div class="jobpilot-step-run-log" :style="runLogStyle">
          <div v-for="(entry, index) in runLog.slice(0, 20)" :key="`${entry.time}-${index}`" class="jobpilot-step-run-log-row" style="display: flex; gap: 8px; font-size: 12px; color: var(--jp-text-secondary)">
            <span style="flex-shrink: 0">{{ entry.time }}</span>
            <span style="min-width: 0; overflow-wrap: anywhere">{{ entry.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type CSSProperties, computed, defineComponent, h } from "vue";
import { t } from "../i18n";
import type { HomePageInput } from "./home";

const props = defineProps<HomePageInput>();

const StepHeading = defineComponent({
  props: { number: { type: String, required: true }, title: { type: String, required: true } },
  setup: (heading) => () =>
    h("div", { class: "jobpilot-step-header", style: "display:flex;align-items:center;gap:8px" }, [
      h("span", { class: "jobpilot-step-badge", style: "font-size:18px" }, heading.number),
      h("span", { class: "jobpilot-step-title" }, heading.title),
    ]),
});

const hintStyle: CSSProperties = { margin: "4px 0 8px", color: "var(--jp-text-secondary)" };
const matchListStyle: CSSProperties = { maxHeight: "180px", overflowY: "auto", marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" };
const runLogStyle: CSSProperties = { marginTop: "8px", maxHeight: "140px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" };
const loginRequired = computed(() => props.isLoggedIn === false || props.pageKind === "login-required" || props.pageKind === "public-home");
const verificationBlock = computed(() => {
  const reason = props.blocked?.reason ?? "";
  return reason.includes("verification") || reason.includes("challenge") || reason.includes("验证");
});
const visibleMatches = computed(() => (props.matches ?? []).slice(0, 20));
const effectiveSelectedCount = computed(() => props.selectedCount ?? (props.matches ?? []).filter((match) => match.selected).length);
const messageStyle = computed(() => ({
  borderLeft: `4px solid ${props.message?.tone === "error" ? "var(--jp-danger)" : props.message?.tone === "warn" ? "var(--jp-warning)" : props.message?.tone === "success" ? "var(--jp-success)" : "var(--jp-primary)"}`,
}));
</script>
