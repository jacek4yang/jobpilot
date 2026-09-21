#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
/**
 * Live-DOM reconnaissance harness — DEVELOPMENT-ONLY maintainer tooling.
 *
 *   pnpm recon:dom
 *
 * Purpose: capture the real BOSS Zhipin DOM structure (search list / job
 * detail / chat list) so that BOSS-adapter selectors in
 * `src/adapters/boss/selectors.ts` can be updated with cited evidence instead
 * of guesses. This is the evidence-gathering half of the selector-promotion
 * loop; the other half is the diagnostic bundle produced by the shipped
 * diagnostic build during a live scenario.
 *
 * =========================================================================
 * HARD BOUNDARIES — read before running, read before editing
 * =========================================================================
 *
 * 1. NEVER RUN IN CI. The harness contacts the live zhipin.com site. CI must
 *    remain loopback-only (see the SAFETY RULE header in ci.yml). A CI guard
 *    below refuses to start when `CI` is set; keep it.
 * 2. NEVER SHIPPED. This script is not part of the userscript bundle and never
 *    will be. It is not imported by anything under `src/`.
 * 3. ANTI-DETECTION BELONGS HERE, NOT IN THE PRODUCT. The harness launches
 *    Camoufox (a Firefox-based automation browser) because an obvious
 *    headless Chromium is flagged by the site's risk control before any DOM
 *    evidence can be read. The shipped userscript runs in the user's own real
 *    browser and deliberately does no fingerprint spoofing of any kind —
 *    see the "Safety model" section of README.md. This harness is the ONLY
 *    place that trade-off exists, and it exists solely to read structure.
 * 4. READ-ONLY ON THE SITE. The harness never clicks a communicate/send
 *    control, never opens a conversation, never types into an editor, and
 *    never submits a form. Navigation + DOM reads only.
 * 5. OUTPUT STAYS PRIVATE. Everything is written under
 *    `test-results/live/<date>/recon/` (gitignored). Real captures are never
 *    committed; only sanitized, minimal fixtures derived from them may enter
 *    Git, after reduction (see docs/diagnostics/PRIVACY.md).
 *
 * Manual step: the browser opens headed; log in by hand (including any
 * CAPTCHA — the harness never solves challenges). Login is detected via the
 * header chat entry, then captures proceed automatically. The profile is
 * persisted under the run directory so a re-run does not need a new login.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

// camoufox's ESM build dynamically requires Node built-ins ("events") and
// crashes under tsx ("Dynamic require of events is not supported"). Its CJS
// build is fine, so load that through createRequire, which resolves the
// package's `require` condition.
const { Camoufox } = createRequire(import.meta.url)("camoufox") as typeof import("camoufox");

if (process.env.CI !== undefined) {
  process.stderr.write(
    "recon:dom refuses to run in CI (live-site contact). See the header comment.\n",
  );
  process.exit(2);
}

const OUT = process.argv[2] ?? defaultRunDir();
const PROFILE = join(OUT, "profile");
mkdirSync(OUT, { recursive: true });

function defaultRunDir(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return join("test-results", "live", date, "recon");
}

/** Selector hypotheses to verify against the live DOM (recon probes only). */
const PROBES = {
  list: {
    jobListBox: [".job-list-box", ".job-list-wrapper", "ul.job-list-box", "[class*='job-list']"],
    card: [".job-card-wrapper", "li.job-card-wrapper", ".job-card", "[class*='job-card']"],
    cardActive: [
      ".job-card-wrapper.active",
      ".job-card-wrapper.is-active",
      ".job-card-wrapper.selected",
    ],
    title: [".job-name", ".job-card__title", "[class*='job-name']"],
    titleLink: ["a[href*='/job_detail/']", ".job-name a", "a.job-card__link"],
    salary: [".salary", "[class*='salary']"],
    tags: [".tag-list li", ".job-card__tags li", "[class*='tag-list'] li"],
    company: [".company-name", "[class*='company-name']"],
    companyTag: [".company-tag-list li", "[class*='company-tag'] li"],
    location: [".job-area", "[class*='job-area']"],
    recruiterLine: [".boss-name", ".info-public", "[class*='boss']"],
    cardFooter: [".card-footer", "[class*='card-footer']"],
    jobIdOnCard: ["[data-job-id]", "[lid]", "a[href*='securityId']", "a[href*='job_detail']"],
  },
  detail: {
    root: [".job-sec-info", ".job-detail", ".detail-content", "#main", "[class*='job-detail']"],
    status: [".job-status", "[class*='job-status']"],
    title: [".job-sec-info h1", ".job-title h1", "h1.name", "[class*='job-title'] h1", "h1"],
    salary: [".salary", ".job-sec-info .salary"],
    meta: [".job-primary .info-primary p", ".info-primary p", "[class*='info-primary'] p"],
    op: [".job-detail-op", ".detail-op", "[class*='job-detail-op']"],
    communicateBtn: [
      "a.btn-apply",
      "a.btn-startchat",
      ".job-detail-op a",
      "a[class*='apply']",
      "a[class*='startchat']",
    ],
    interestedBtn: ["a.op-apply-like", "a[class*='like']"],
    companyInfo: [".job-sec-info.company-info", ".company-info", "[class*='company-info']"],
    sider: [".job-sec-info.sider", ".sider", "[class*='sider']"],
    recruiter: [".job-boss-info", ".boss-info-attr", "[class*='boss-info']", "[class*='job-boss']"],
    recruiterName: [".boss-info-attr .name", ".job-boss-info .name", "[class*='boss'] .name"],
    recruiterStatus: [".boss-active-time", "[class*='active-time']", "[class*='active']"],
    description: [".job-sec-text", ".job-description", "[class*='job-sec-text']"],
    skillTags: [".job-keyword-list li", ".tag-list li", "[class*='keyword'] li"],
    jobIdInDom: ["[data-jobid]", "[data-job-id]", "[data-securityid]", "[data-lid]"],
  },
  chat: {
    list: [".user-list", "[class*='user-list']", ".chat-user-list"],
    item: [".user-list li", ".chat-user-list li", "[class*='user-list'] li"],
    itemName: [".user-name", "[class*='user-name']"],
    searchInput: ["input[placeholder*='联系人']", ".search-input input", "[class*='search'] input"],
    tabs: [".chat-tab", "[class*='chat-tab']"],
    panel: [".chat-panel", ".chat-conversation", "[class*='chat-panel']"],
    emptyState: [".chat-empty", "[class*='empty']"],
  },
  guards: {
    geetest: [".geetest_panel", "#geetest", "[class*='geetest']", "[id*='geetest']"],
    captcha: ["[class*='captcha']", "[id*='captcha']"],
    verifyWrap: [".verify-wrap", "[class*='verify-wrap']", "[class*='verify']"],
    loginDialog: [
      ".login-register",
      ".sign-wrap",
      "[class*='login-dialog']",
      "[class*='login-box']",
    ],
    securityCheck: ["[class*='security']", "body"],
  },
} as const;

interface ProbeMatch {
  readonly sel: string;
  readonly count: number;
  readonly first: string;
}

async function probe(
  page: Page,
  group: keyof typeof PROBES,
): Promise<Record<string, readonly ProbeMatch[]>> {
  const out: Record<string, readonly ProbeMatch[]> = {};
  for (const [key, sels] of Object.entries(PROBES[group])) {
    const matches: ProbeMatch[] = [];
    for (const sel of sels) {
      try {
        const count = await page.locator(sel).count();
        let first = "";
        if (count > 0) {
          const html = await page
            .locator(sel)
            .first()
            .evaluate((el) => el.outerHTML.slice(0, 500));
          first = html.replace(/\s+/g, " ").slice(0, 300);
        }
        matches.push({ sel, count, first });
      } catch (e) {
        matches.push({ sel, count: -1, first: String(e).slice(0, 120) });
      }
    }
    out[key] = matches;
  }
  return out;
}

const run = async (): Promise<void> => {
  // Camoufox (devDependency): Firefox-based automation browser used ONLY here,
  // because an unmodified headless Chromium is flagged by the site's risk
  // control before any DOM evidence can be read. `data_dir` persists the
  // profile so the manual login survives re-runs. No proxy is configured:
  // connections go direct from this machine.
  // `data_dir` is always set, so Camoufox resolves to a persistent
  // BrowserContext. The cast reflects that invariant.
  const context = (await Camoufox({
    headless: false,
    os: "windows",
    locale: ["zh-CN"],
    window: [1440, 900],
    humanize: true,
    data_dir: PROFILE,
  })) as BrowserContext;
  const page = context.pages()[0] ?? (await context.newPage());

  console.log("[recon] opened Camoufox — please log in to zhipin.com by hand (incl. any CAPTCHA).");
  await page.goto("https://www.zhipin.com/", { waitUntil: "domcontentloaded" });
  await page.bringToFront().catch(() => {});
  console.log(`[recon] navigated tab to: ${page.url()}`);

  // Poll for login: the logged-in header nav contains a link to the chat page.
  const loginDeadline = Date.now() + 20 * 60 * 1000;
  let loggedIn = false;
  let lastLog = 0;
  while (Date.now() < loginDeadline) {
    if (Date.now() - lastLog > 60000) {
      console.log(`[recon] waiting for login… current tab URL: ${page.url()}`);
      lastLog = Date.now();
    }
    const hasChatEntry = await page
      .locator("a[href*='/web/geek/chat']")
      .count()
      .catch(() => 0);
    if (hasChatEntry > 0) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!loggedIn) {
    console.log("[recon] login not detected within 20 min — exiting.");
    await context.close();
    process.exit(2);
  }
  console.log("[recon] login detected. Starting capture (read-only)…");
  await page.waitForTimeout(3000);

  const report: {
    capturedAt: string;
    pages: Record<string, unknown>;
  } = { capturedAt: new Date().toISOString(), pages: {} };

  // --- 1. Search list pages across several cities ---
  const cities: readonly (readonly [string, string])[] = [
    ["beijing", "101010100"],
    ["shanghai", "101020100"],
    ["shenzhen", "101280600"],
  ];
  for (const [name, code] of cities) {
    const url = `https://www.zhipin.com/web/geek/job?query=Java&city=${code}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    report.pages[`list-${name}`] = {
      url: page.url(),
      title: await page.title(),
      probes: await probe(page, "list"),
      guards: await probe(page, "guards"),
    };
    console.log(`[recon] list-${name} captured`);
  }

  // --- 2. Job detail page from the last list (navigation only) ---
  const detailHref = await page
    .locator("a[href*='/job_detail/']")
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (detailHref !== null) {
    const abs = detailHref.startsWith("http") ? detailHref : `https://www.zhipin.com${detailHref}`;
    await page.goto(abs, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    report.pages["job-detail"] = {
      url: page.url(),
      title: await page.title(),
      probes: await probe(page, "detail"),
      guards: await probe(page, "guards"),
    };
    console.log("[recon] job-detail captured");
  } else {
    console.log("[recon] WARN: no /job_detail/ link found on the list page.");
  }

  // --- 3. Chat list page (never opens a conversation) ---
  await page.goto("https://www.zhipin.com/web/geek/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  report.pages["chat-list"] = {
    url: page.url(),
    title: await page.title(),
    probes: await probe(page, "chat"),
    guards: await probe(page, "guards"),
  };
  console.log("[recon] chat-list captured");

  const file = join(OUT, "dom-report.json");
  writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  console.log(`[recon] done → ${file}`);
  await context.close();
};

run().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
