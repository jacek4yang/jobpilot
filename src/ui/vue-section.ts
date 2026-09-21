/**
 * Vue section mounting helper.
 *
 * A panel section (e.g. the Search page) is a Vue app mounted once per document
 * into a wrapper element that the panel render loop appends to its tab panel.
 *
 * The mounted section is cached by the caller and updated via `update(props)`:
 * re-rendering the panel must NOT re-mount or re-append the wrapper, or the
 * browser drops focus from whatever input the user is typing into. Reactive
 * props mean a re-render only patches text — the DOM nodes (and focus) stay.
 *
 * Implementation note: the app root is a thin host component rendering the
 * section via the normal parent/child contract. Passing the props straight to
 * `createApp` would freeze them — a root component's props are snapshotted at
 * mount and are never patched afterwards. The spread reads every prop, so
 * `update()` mutations re-render the host and flow into the section as real
 * prop patches (values and event handlers alike).
 */

import { type App, type Component, createApp, defineComponent, h, reactive } from "vue";

export interface MountedSection<P extends object> {
  readonly el: HTMLElement;
  update(props: P): void;
  unmount(): void;
}

export const mountSection = <P extends object>(
  doc: Document,
  component: unknown,
  initial: P,
): MountedSection<P> => {
  const el = doc.createElement("div");
  const props = reactive({ ...initial }) as P;
  const host = defineComponent({
    name: "JobPilotSectionHost",
    setup: () => () => h(component as Component, { ...props }),
  });
  const app: App = createApp(host);
  app.mount(el);
  return {
    el,
    update: (next) => {
      Object.assign(props, next);
    },
    unmount: () => {
      app.unmount();
    },
  };
};
