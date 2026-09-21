/**
 * Home page adapter.
 *
 * The Home surface is mounted once per document and subsequently receives
 * reactive prop updates. Bootstrap renders after asynchronous page, storage
 * and controller updates; rebuilding the section would drop focus, IME
 * composition, checkbox focus and list scroll position during selection.
 */

import type { BlockedView, MatchRowView, PendingDecisionView, UiCallbacks } from "../view-model";
import type { MountedSection } from "../vue-section";
import { mountSection } from "../vue-section";
import HomePage from "./HomePage.vue";

export interface HomePageInput {
  readonly message?:
    | {
        readonly tone: "info" | "warn" | "error" | "success";
        readonly text: string;
      }
    | undefined;
  readonly blocked?: BlockedView | undefined;
  readonly decisions: readonly PendingDecisionView[];
  readonly callbacks: UiCallbacks;
  readonly matches?: readonly MatchRowView[] | undefined;
  readonly discoveryNote?: string | undefined;
  readonly runLog?: readonly { readonly time: string; readonly text: string }[] | undefined;
  readonly selectedCount?: number | undefined;
  readonly isLoggedIn?: boolean | undefined;
  readonly pageKind?: string | undefined;
  readonly running?: boolean | undefined;
  readonly paused?: boolean | undefined;
}

const sections = new WeakMap<Document, MountedSection<HomePageInput>>();

export const renderHomePage = (doc: Document, input: HomePageInput): HTMLElement => {
  const section = sections.get(doc);
  if (section !== undefined) {
    section.update(input);
    return section.el;
  }

  const mounted = mountSection<HomePageInput>(doc, HomePage, input);
  sections.set(doc, mounted);
  return mounted.el;
};
