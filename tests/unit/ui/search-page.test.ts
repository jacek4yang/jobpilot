/**
 * Search page persistence tests.
 *
 * Regression: typing into the Search page (e.g. the salary inputs) was wiped
 * as soon as the panel re-rendered — the page rebuilt its DOM from persisted
 * state on every render and nothing stored what was typed. These tests pin:
 *
 *   - every control change calls onSaveSearchProfile with the full profile
 *     read back from the inputs (write-through);
 *   - a re-render that lands before the storage round-trip still shows the
 *     typed value (module-scope draft wins over stale persisted state);
 *   - the salary fields in particular keep their text across re-renders.
 *
 * Profile ids are unique per test so the module-scope draft map never leaks
 * between tests.
 */
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
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

describe("renderSearchPage persistence", () => {
  it("salary typing fires onSaveSearchProfile with the parsed numbers", () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("p-salary-write"),
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

  it("typed salary survives a re-render that lands before storage round-trip", () => {
    const saved: StoredSearchProfile[] = [];
    const config = configWithProfile("p-salary-rerender");
    const doc = makeDoc();
    const first = renderSearchPage(doc, { config, callbacks: callbacksWith(saved) });
    const [minFirst] = salaryInputsOf(first);

    minFirst.value = "20";
    fire(doc, minFirst, "input");
    expect(saved.at(-1)?.salaryMinK).toBe(20);

    // Re-render with the ORIGINAL (stale) config — the storage write has not
    // landed yet. The draft must win or the keystroke is wiped.
    const second = renderSearchPage(doc, { config, callbacks: callbacksWith([]) });
    const [minSecond] = salaryInputsOf(second);
    expect(minSecond.value).toBe("20");
  });

  it("city chips, filters and the activity select all persist on change", () => {
    const saved: StoredSearchProfile[] = [];
    const doc = makeDoc();
    const page = renderSearchPage(doc, {
      config: configWithProfile("p-chips"),
      callbacks: callbacksWith(saved),
    });

    const chip = Array.from(page.querySelectorAll("button.jobpilot-filter-chip")).find(
      (node) => node.textContent === "北京",
    );
    if (chip) fire(doc, chip, "click");
    expect(saved.at(-1)?.cities).toContain("北京");

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
      config: configWithProfile("p-keywords"),
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
});
