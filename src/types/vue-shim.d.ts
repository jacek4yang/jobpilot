/**
 * Type shim for Vue single-file components.
 *
 * The project typechecks with plain `tsc` (no vue-tsc), so `.vue` imports need
 * an ambient declaration to resolve. Logic-heavy code lives in plain `.ts`
 * modules; the SFCs are thin template + setup glue, so the loss of precise
 * typing here is deliberate and contained.
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
