/**
 * Search page Vue render smoke test.
 *
 * Pins the DOM contract of the Vue-backed Search page:
 *
 *   - the rendered tree keeps the established selectors (`.jobpilot-page-search`,
 *     `.jobpilot-input`, `.jobpilot-btn[data-variant=primary]`,
 *     `.jobpilot-filter-chip[data-selected]`, `.jobpilot-select`);
 *   - typing writes the full profile through to `onSaveSearchProfile` with
 *     parsed salary numbers (same behavioural assertions as the old
 *     hand-rolled page tests);
 *   - re-calling `renderSearchPage` with the SAME document returns the SAME
 *     element (the no-rebuild contract) and a re-render with stale config
 *     keeps the typed value (the draft contract).
 *
 * Vue mounts against happy-dom here; if that combination stops working, this
 * file is the place that fails, not the pure `search-form` tests.
 */
// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { JobPilotConfig, StoredSearchProfile } from "../../../src/config/schema";
import { renderSearchPage } from "../../../src/ui/pages/search";
import type { UiCallbacks } from "../../../src/ui/view-model";

const configWithProfile = (id: string, profile?: Partial<StoredSearchProfile>): JobPilotConfig => ({
  general: { enabled: true, locale: "zh-CN", enabledPlatforms: ["boss"], pauseOnNavigation: true },
  filters: {
    cities: [],
    minSalaryK: 0,
    maxSalaryK: 0,
    education: [],
    experience: [],
    includeKeywords: [],
    excludeKeywords: [],
    companyBlacklist: [],
    excludeOutsourcing: false,
    excludeHeadhunter: false,
    skipProcessed: true,
  },
  profiles: [
    {
      id,
      name: "测试意向",
      keywords: [],
      cities: [],
      includeKeywords: [],
      excludeKeywords: [],
      enabled: true,
      ...profile,
    },
  ],
  scoring: {
    baseScore: 0,
    acceptThreshold: 60,
    maxScore: 100,
    titleKeywords: [],
    descriptionKeywords: [],
    preferredSkills: [],
    preferredCities: [],
  },
  automation: {
    mode: "assist",
    acknowledgeRisks: false,
    maxApplicationsPerSession: 20,
    maxApplicationsPerHour: 50,
    maxRetries: 2,
    minActionDelayMs: 800,
    maxActionDelayMs: 2500,
    verifyAfterSubmit: true,
    stopOnUnknownDom: true,
  },
  rateLimit: {
    minNavigationDelayMs: 2000,
    failureBackoffMs: 30_000,
    maxConsecutiveFailures: 3,
    stopOnCircuitBreak: true,
  },
  ui: {
    showPanel: true,
    panelPosition: "bottom-right",
    showReasons: true,
    compactMode: false,
  },
  logging: { level: "info", maxEntries: 500, persistLogs: false, telemetryEnabled: false },
});

const callbacksWith = (saved: StoredSearchProfile[]): UiCallbacks => ({
  discover: () => {},
  start: () => {},
  pause: () => {},
  resume: () => {},
  recheck: () => {},
  skipCurrent: () => {},
  stop: () => {},
  setCollapsed: () => {},
  onSaveSearchProfile: (profile) => {
    saved.push(profile);
  },
});

/** A happy-dom document in the DOM-lib type the renderers accept. */
const makeDoc = (): Document => new Window().document as unknown as Document;

/** Dispatches an event of the right realm for the given document. */
const fire = (doc: Document, target: EventTarget, type: string): void => {
  const view = doc.defaultView;
  if (view === null) throw new Error("document has no window");
  target.dispatchEvent(new view.Event(type, { bubbles: true }));
};

const salaryInputsOf = (root: HTMLElement): [HTMLInputElement, HTMLInputElement] => {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input[type='number']"));
  if (inputs.length !== 2) throw new Error(`expected 2 salary inputs, got ${inputs.length}`);
  return [inputs[0] as HTMLInputElement, inputs[1] as HTMLInputElement];
};

describe("renderSearchPage (Vue)", () => {
  it("renders the keyword input with the configured profile value", () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("v-render", { keywords: ["Golang", "后端"] }),
      callbacks: callbacksWith(saved),
    });

    expect(page.querySelector(".jobpilot-page-search")).not.toBeNull();
    const textInput = page.querySelector("input.jobpilot-input");
    if (textInput === null) throw new Error("keyword input missing");
    expect(textInput).toHaveProperty("value", "Golang, 后端");

    const runBtn = page.querySelector("button.jobpilot-btn[data-variant='primary']");
    if (runBtn === null) throw new Error("run button missing");
    expect(runBtn.textContent).toBe("开始整理职位");
  });

  it("salary typing fires onSaveSearchProfile with the parsed numbers", () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("v-salary-write"),
      callbacks: callbacksWith(saved),
    });
    const [minInput, maxInput] = salaryInputsOf(page);

    minInput.value = "15";
    fire(doc, minInput, "input");
    maxInput.value = "30";
    fire(doc, maxInput, "input");

    expect(saved.length).toBe(2);
    const latest = saved.at(-1);
    expect(latest?.salaryMinK).toBe(15);
    expect(latest?.salaryMaxK).toBe(30);
  });

  it("city chips, filters and the activity select all persist on change", async () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("v-chips"),
      callbacks: callbacksWith(saved),
    });

    const chip = Array.from(page.querySelectorAll("button.jobpilot-filter-chip")).find(
      (node) => node.textContent === "北京",
    );
    if (chip === undefined) throw new Error("北京 chip missing");
    expect(chip.getAttribute("data-selected")).toBe("false");
    fire(doc, chip, "click");
    expect(saved.at(-1)?.cities).toContain("北京");
    // The selected state is a reactive prop patch — flushed on the microtask.
    await nextTick();
    expect(chip.getAttribute("data-selected")).toBe("true");

    const select = page.querySelector("select.jobpilot-select");
    const SelectClass = doc.defaultView?.HTMLSelectElement;
    if (select === null || SelectClass === undefined || !(select instanceof SelectClass)) {
      throw new Error("activity select missing");
    }
    const option = Array.from(select.options).find((o) => o.value.length > 0);
    select.value = option?.value ?? "";
    fire(doc, select, "change");
    expect(saved.at(-1)?.recruiterActivity).toBe(option?.value);
  });

  it("keyword typing persists tokens, split on commas and whitespace", () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("v-keywords"),
      callbacks: callbacksWith(saved),
    });
    const textInput = page.querySelector("input.jobpilot-input");
    const InputClass = doc.defaultView?.HTMLInputElement;
    if (textInput === null || InputClass === undefined || !(textInput instanceof InputClass)) {
      throw new Error("keyword input missing");
    }

    textInput.value = "Java, 后端 微服务";
    fire(doc, textInput, "input");

    expect(saved.at(-1)?.keywords).toEqual(["Java", "后端", "微服务"]);
  });

  it("same document returns the same element and stale re-render keeps typed values", async () => {
    const saved: StoredSearchProfile[] = [];
    const config = configWithProfile("v-rerender");
    const doc = makeDoc();
    const first = renderSearchPage(doc, { config, callbacks: callbacksWith(saved) });
    const textInput = first.querySelector("input.jobpilot-input");
    const InputClass = doc.defaultView?.HTMLInputElement;
    if (textInput === null || InputClass === undefined || !(textInput instanceof InputClass)) {
      throw new Error("keyword input missing");
    }

    textInput.value = "typed-keyword";
    fire(doc, textInput, "input");
    expect(saved.at(-1)?.keywords).toEqual(["typed-keyword"]);

    // Re-render with the ORIGINAL (stale) config — the storage write has not
    // landed yet. The mounted section must be updated in place, not rebuilt,
    // and the draft must win or the keystroke is wiped.
    const after: StoredSearchProfile[] = [];
    const second = renderSearchPage(doc, { config, callbacks: callbacksWith(after) });
    expect(second).toBe(first);
    await nextTick();
    expect(textInput.value).toBe("typed-keyword");

    // The refreshed callbacks are wired: a chip click now saves into `after`.
    const chip = Array.from(second.querySelectorAll("button.jobpilot-filter-chip")).find(
      (node) => node.textContent === "北京",
    );
    if (chip === undefined) throw new Error("北京 chip missing");
    fire(doc, chip, "click");
    expect(after.at(-1)?.cities).toContain("北京");
    expect(after.at(-1)?.keywords).toEqual(["typed-keyword"]);
  });
});
