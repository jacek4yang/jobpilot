/**
 * Message templates.
 *
 * A first message is the only user-authored content JobPilot sends, so the
 * rules are strict:
 *  - rendering is deterministic and local;
 *  - a variable that cannot be resolved is an error, never invented;
 *  - blank input is rejected rather than sent as an empty message.
 *
 * The reference implementation only ever sent BOSS's first saved common phrase.
 * Templates generalise that while keeping "use my BOSS common phrase" as one
 * source option, so the familiar workflow still exists.
 */
import type { JobDetail } from "../job/job";

/** Where the outgoing text comes from. */
export type MessageSource =
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "boss-common-phrase" };

export interface MessageTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

/**
 * Variables JobPilot can resolve from the job it already parsed.
 *
 * Deliberately tiny. Anything not on this list would have to be guessed, and a
 * guessed recruiter name in a first message is worse than no personalisation.
 */
export const TEMPLATE_VARIABLES: readonly string[] = ["jobTitle", "company", "recruiter"];

export interface TemplateContext {
  readonly job: JobDetail;
}

export type RenderResult =
  | { readonly ok: true; readonly text: string; readonly usedVariables: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "empty" | "missing-variable" | "unknown-variable";
      readonly detail: string;
    };

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** Resolves a variable, returning undefined when the data is not available. */
const resolveVariable = (name: string, context: TemplateContext): string | undefined => {
  switch (name) {
    case "jobTitle": {
      const title = context.job.title.trim();
      return title.length > 0 ? title : undefined;
    }
    case "company": {
      const company = context.job.company.name.trim();
      return company.length > 0 ? company : undefined;
    }
    case "recruiter": {
      // A recruiter is optional; one is only used when the name is non-empty.
      const recruiter = context.job.recruiters[0]?.name.trim();
      return recruiter !== undefined && recruiter.length > 0 ? recruiter : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Renders a template against a job.
 *
 * Fails rather than degrading: an unknown variable name or a variable with no
 * data produces an error the UI can show, so the user fixes the template
 * instead of sending a message containing `{{recruiter}}` verbatim.
 */
export const renderTemplate = (content: string, context: TemplateContext): RenderResult => {
  if (content.trim().length === 0) {
    return { ok: false, reason: "empty", detail: "template content is empty" };
  }

  const usedVariables: string[] = [];
  let failure: RenderResult | undefined;

  const text = content.replace(VARIABLE_PATTERN, (whole, rawName: string) => {
    if (failure !== undefined) return whole;

    if (!TEMPLATE_VARIABLES.includes(rawName)) {
      failure = {
        ok: false,
        reason: "unknown-variable",
        detail: `template uses unknown variable {{${rawName}}}; supported: ${TEMPLATE_VARIABLES.join(", ")}`,
      };
      return whole;
    }

    const value = resolveVariable(rawName, context);
    if (value === undefined) {
      failure = {
        ok: false,
        reason: "missing-variable",
        detail: `{{${rawName}}} could not be resolved for this job`,
      };
      return whole;
    }

    usedVariables.push(rawName);
    return value;
  });

  if (failure !== undefined) return failure;
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty", detail: "template rendered to an empty message" };
  }

  return { ok: true, text: text.trim(), usedVariables };
};

/**
 * Validates a template without a job attached.
 *
 * Used by the Messages editor so a mistake is caught while writing, rather than
 * at send time in the middle of a queue run.
 */
export const validateTemplateContent = (content: string): RenderResult => {
  if (content.trim().length === 0) {
    return { ok: false, reason: "empty", detail: "template content is empty" };
  }

  const names = [...content.matchAll(VARIABLE_PATTERN)].map((match) => match[1] ?? "");
  const unknown = names.find((name) => !TEMPLATE_VARIABLES.includes(name));
  if (unknown !== undefined) {
    return {
      ok: false,
      reason: "unknown-variable",
      detail: `unknown variable {{${unknown}}}; supported: ${TEMPLATE_VARIABLES.join(", ")}`,
    };
  }

  return { ok: true, text: content.trim(), usedVariables: names };
};

export const createTemplate = (input: {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
}): MessageTemplate => ({
  id: input.id,
  name: input.name.trim(),
  content: input.content,
  enabled: input.enabled ?? true,
  isDefault: input.isDefault ?? false,
});

/**
 * Picks the template to use.
 *
 * Returns `undefined` when nothing usable is configured, which the caller must
 * treat as "do not send" rather than falling back to an empty message.
 */
export const selectTemplate = (
  templates: readonly MessageTemplate[],
  preferredId?: string,
): MessageTemplate | undefined => {
  const enabled = templates.filter((template) => template.enabled);
  if (preferredId !== undefined) {
    const preferred = enabled.find((template) => template.id === preferredId);
    if (preferred !== undefined) return preferred;
  }
  return enabled.find((template) => template.isDefault) ?? enabled[0];
};

/**
 * Structural presets.
 *
 * These are *shapes*, not copy: they contain no industry keywords and no
 * opinionated claims about the user, and the blank preset is deliberately first
 * so a new user is not nudged into sending text they did not write.
 */
export interface TemplatePreset {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly description: string;
}

export const TEMPLATE_PRESETS: readonly TemplatePreset[] = [
  {
    id: "blank",
    name: "Blank",
    content: "",
    description: "Start from nothing and write your own message.",
  },
  {
    id: "short",
    name: "Short greeting",
    content: "您好，我对{{jobTitle}}这个职位很感兴趣，方便聊聊吗？",
    description: "One line, mentions the role.",
  },
  {
    id: "role-specific",
    name: "Role-specific greeting",
    content:
      "您好，我看到{{company}}正在招聘{{jobTitle}}，我的经历与该岗位比较匹配，希望有机会详聊。",
    description: "Mentions the role and the company.",
  },
  {
    id: "graduate",
    name: "Graduate greeting",
    content: "您好，我是应届毕业生，对{{jobTitle}}很感兴趣，希望有机会进一步了解这个岗位。",
    description: "For early-career applications.",
  },
];
