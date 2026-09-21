<template>
  <div class="jobpilot-page-search">
    <div class="jobpilot-card">
      <h3 style="margin: 0 0 4px; font-size: 14px; font-weight: 600">{{ t("search.title") }}</h3>
      <p class="jobpilot-field-hint" style="margin: 0 0 10px">{{ t("search.subtitle") }}</p>
      <button type="button" class="jobpilot-btn" data-variant="primary" @click="emit('run')">
        {{ t("search.runSearch") }}
      </button>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.keywordsGroup") }}</label>
      <input
        v-model="model.keywords"
        class="jobpilot-input"
        :placeholder="t('search.keywordsPlaceholder')"
        @input="persist"
      />
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.citiesGroup") }}</label>
      <input
        v-model="model.cities"
        class="jobpilot-input"
        :placeholder="t('search.citiesPlaceholder')"
        @input="persist"
      />
      <div class="jobpilot-chips-container">
        <button
          v-for="city in COMMON_CITIES"
          :key="city"
          type="button"
          class="jobpilot-filter-chip"
          :data-selected="selectedCities.has(city)"
          @click="toggleCity(city)"
        >
          {{ city }}
        </button>
      </div>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.salaryGroup") }}</label>
      <div style="display: flex; gap: 8px; align-items: center">
        <input
          type="number"
          class="jobpilot-input"
          :placeholder="t('search.salaryMin')"
          :value="model.salaryMinK ?? ''"
          @input="onSalaryMin"
        />
        <span style="color: var(--jp-text-muted)">—</span>
        <input
          type="number"
          class="jobpilot-input"
          :placeholder="t('search.salaryMax')"
          :value="model.salaryMaxK ?? ''"
          @input="onSalaryMax"
        />
      </div>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.experienceGroup") }}</label>
      <div class="jobpilot-chips-container">
        <button
          v-for="band in EXPERIENCE_BANDS"
          :key="band"
          type="button"
          class="jobpilot-filter-chip"
          :data-selected="model.experience.includes(band)"
          @click="toggleExperience(band)"
        >
          {{ band }}
        </button>
      </div>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.educationGroup") }}</label>
      <div class="jobpilot-chips-container">
        <button
          v-for="deg in DEGREE_LEVELS"
          :key="deg"
          type="button"
          class="jobpilot-filter-chip"
          :data-selected="model.degree.includes(deg)"
          @click="toggleDegree(deg)"
        >
          {{ deg }}
        </button>
      </div>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.companyScaleGroup") }}</label>
      <div class="jobpilot-chips-container">
        <button
          v-for="scale in COMPANY_SCALES"
          :key="scale"
          type="button"
          class="jobpilot-filter-chip"
          :data-selected="model.companyScales.includes(scale)"
          @click="toggleScale(scale)"
        >
          {{ scale }}
        </button>
      </div>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.activityGroup") }}</label>
      <select class="jobpilot-select" @change="onActivity">
        <option
          v-for="act in ACTIVITY_PREFERENCES"
          :key="act"
          :value="act"
          :selected="model.recruiterActivity === act"
        >
          {{ ACTIVITY_LABELS[act] }}
        </option>
      </select>
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.includeKeywordsGroup") }}</label>
      <input
        v-model="model.includeKeywords"
        class="jobpilot-input"
        :placeholder="t('search.includePlaceholder')"
        @input="persist"
      />
    </div>

    <div class="jobpilot-card">
      <label class="jobpilot-field-label">{{ t("search.excludeKeywordsGroup") }}</label>
      <input
        v-model="model.excludeKeywords"
        class="jobpilot-input"
        :placeholder="t('search.excludePlaceholder')"
        @input="persist"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { StoredSearchProfile } from "../../../config/schema";
import {
  ACTIVITY_LABELS,
  ACTIVITY_PREFERENCES,
  COMPANY_SCALES,
  DEGREE_LEVELS,
  EXPERIENCE_BANDS,
} from "../../../domain/search-profile/profile";
import { t } from "../../i18n";
import {
  COMMON_CITIES,
  profileFromModel,
  type SearchFormModel,
  salaryValue,
  splitTokens,
} from "./search-form";

const props = defineProps<{
  profile: StoredSearchProfile;
  model: SearchFormModel;
  onSave: (profile: StoredSearchProfile) => void;
  onRun: () => void;
}>();

const emit = defineEmits<{
  (e: "save", profile: StoredSearchProfile): void;
  (e: "run"): void;
}>();

/**
 * Local editable copy. Panel re-renders push fresh draft-resolved props; the
 * watch folds them in without rebuilding the DOM, so focus and caret survive
 * a re-render mid-keystroke. Keystrokes write into this same object, which is
 * what makes typing independent of re-renders.
 */
const model = reactive<SearchFormModel>({ ...props.model });

watch(
  () => props.model,
  (next) => {
    Object.assign(model, next);
  },
);

/** Emits the full profile built from the current form values. */
const persist = (): void => {
  emit("save", profileFromModel(props.profile.id, props.profile.name, model));
};

/** City chip state derives from the input tokens, exactly like the old page. */
const selectedCities = computed(() => new Set(splitTokens(model.cities)));

const toggleCity = (city: string): void => {
  const list = [...splitTokens(model.cities)];
  const idx = list.indexOf(city);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(city);
  }
  model.cities = list.join(", ");
  persist();
};

const toggleExperience = (band: string): void => {
  model.experience = model.experience.includes(band)
    ? model.experience.filter((b) => b !== band)
    : [...model.experience, band];
  persist();
};

const toggleDegree = (deg: string): void => {
  model.degree = model.degree.includes(deg)
    ? model.degree.filter((b) => b !== deg)
    : [...model.degree, deg];
  persist();
};

const toggleScale = (scale: string): void => {
  model.companyScales = model.companyScales.includes(scale)
    ? model.companyScales.filter((b) => b !== scale)
    : [...model.companyScales, scale];
  persist();
};

const onSalaryMin = (event: Event): void => {
  model.salaryMinK = salaryValue((event.target as HTMLInputElement).value);
  persist();
};

const onSalaryMax = (event: Event): void => {
  model.salaryMaxK = salaryValue((event.target as HTMLInputElement).value);
  persist();
};

const onActivity = (event: Event): void => {
  const value = (event.target as HTMLSelectElement).value;
  model.recruiterActivity = value.length === 0 ? undefined : value;
  persist();
};
</script>
