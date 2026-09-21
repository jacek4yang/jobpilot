/**
 * Search page adapter.
 *
 * Keeps the old `renderSearchPage(doc, input) → HTMLElement` call signature
 * (sections.ts needs no changes) while the page itself is a Vue SFC mounted
 * once per document. Every later call with the same document is a prop update
 * on the cached section — the DOM, and any focus inside it, is never rebuilt.
 */

import type { JobPilotConfig, StoredSearchProfile } from "../../../config/schema";
import type { UiCallbacks } from "../../view-model";
import { type MountedSection, mountSection } from "../../vue-section";
import SearchPage from "./SearchPage.vue";
import {
  drafts,
  modelFromProfile,
  resolveProfile,
  resolveProfileId,
  type SearchFormModel,
} from "./search-form";

export interface SearchPageInput {
  readonly config?: JobPilotConfig | undefined;
  readonly callbacks: UiCallbacks;
}

interface SearchSectionProps {
  profile: StoredSearchProfile;
  model: SearchFormModel;
  onSave: (profile: StoredSearchProfile) => void;
  onRun: () => void;
}

/** One mounted section per document, so fresh documents in tests never leak. */
const sections = new WeakMap<Document, MountedSection<SearchSectionProps>>();

export const renderSearchPage = (doc: Document, input: SearchPageInput): HTMLElement => {
  const profileId = resolveProfileId(input.config);
  const profile = resolveProfile(profileId, input.config);
  const model = modelFromProfile(profile, input.config);

  const onSave = (next: StoredSearchProfile): void => {
    // Newest draft wins over the persisted profile on the next re-render, so
    // a re-render driven by stale config cannot wipe what was just typed.
    drafts.set(next.id, next);
    input.callbacks.onSaveSearchProfile?.(next);
  };
  const onRun = (): void => {
    input.callbacks.discover();
  };

  let section = sections.get(doc);
  if (section === undefined) {
    section = mountSection<SearchSectionProps>(doc, SearchPage, {
      profile,
      model,
      onSave,
      onRun,
    });
    sections.set(doc, section);
    return section.el;
  }
  section.update({ profile, model, onSave, onRun });
  return section.el;
};
