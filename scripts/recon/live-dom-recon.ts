#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
/**
 * Live-DOM reconnaissance harness — DEVELOPMENT-ONLY maintainer tooling.
 *
 *   pnpm recon:dom            # start a long-lived session (default dir)
 *   pnpm recon:dom <dir>      # start with an explicit run directory
 *
 * Purpose: capture the real BOSS Zhipin DOM structure (search list / job
 * detail / chat list) so that BOSS-adapter selectors in
 * `src/adapters/boss/selectors.ts` can be updated with cited evidence instead
 * of guesses. This is the evidence-gathering half of the selector-promotion
 * loop; the other half is the diagnostic bundle produced by the shipped
 * diagnostic build during a live scenario.
 *
 * SESSION MODEL. The browser opens ONCE and stays open. You log in ONCE
 * (including any CAPTCHA — the harness never solves challenges). After that,
 * the agent drives everything by dropping command files into `<dir>/cmd/` and
 * reading `<dir>/result/<id>.json`. Restarting the browser regenerates the
 * fingerprint and the site treats it as a new device, which invalidates the
 * session — that is why this loop never restarts the browser mid-work.
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
 * COMMAND PROTOCOL (the agent side):
 *   write <dir>/cmd/<id>.json   →   harness writes <dir>/result/<id>.json
 * Commands (whitelisted ops only — no arbitrary eval):
 *   {"op":"url"}                      → {url, title}
 *   {"op":"probe","kind":"list|detail|chat|chatOpen|guards"}
 *   {"op":"deep","kind":"list|detail|chatOpen"}
 *   {"op":"done"}                     → closes the browser and exits
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

const args = process.argv.slice(2).filter((a) => a !== "--");
const OUT = args.find((a) => !a.startsWith("--")) ?? defaultRunDir();
const PROFILE = join(OUT, "profile");
const CMD_DIR = join(OUT, "cmd");
const RESULT_DIR = join(OUT, "result");
mkdirSync(OUT, { recursive: true });
mkdirSync(CMD_DIR, { recursive: true });
mkdirSync(RESULT_DIR, { recursive: true });

function defaultRunDir(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return join("test-results", "live", date, "recon");
}

/** Selector hypotheses to verify against the live DOM (recon probes only). */
const PROBES = {
  list: {
    jobListBox: [".job-list-container", ".job-list-box", "[class*='job-list']"],
    card: [".job-card-wrap", ".job-card-box", "[class*='job-card']"],
    cardActive: [".job-card-wrap.active"],
    title: [".job-name", "[class*='job-name']"],
    titleLink: ["a[href*='/job_detail/']"],
    salary: [".job-salary", "[class*='salary']"],
    tags: [".tag-list li", "[class*='tag-list'] li"],
    company: [".company-name", "[class*='company']"],
    companyLink: ["a[href*='/gongsi/']"],
    location: [".job-area", "[class*='job-area']", "[class*='job-loc']"],
    recruiterLine: [".boss-name", "[class*='boss-name']"],
    cardFooter: [".job-card-footer", "[class*='card-footer']"],
    jobIdOnCard: ["a[href*='securityId']", "a[href*='/job_detail/']"],
  },
  detail: {
    root: [".job-sec-info", ".job-detail", ".detail-content", "[class*='job-detail']"],
    status: [".job-status", "[class*='job-status']"],
    title: [".job-sec-info h1", ".job-title h1", "h1.name", "[class*='job-title'] h1", "h1"],
    salary: [".salary", ".job-sec-info .salary"],
    meta: [".info-primary p", "[class*='info-primary'] p"],
    op: [".job-detail-op", "[class*='job-detail-op']"],
    communicateBtn: [
      "a.btn-apply",
      "a.btn-startchat",
      ".job-detail-op a",
      "a[class*='apply']",
      "a[class*='startchat']",
    ],
    interestedBtn: ["a.op-apply-like", "a[class*='like']"],
    companyInfo: [".job-sec-info.company-info", ".company-info", "[class*='company-info']"],
    sider: [".sider", "[class*='sider']"],
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
    searchInput: ["input[placeholder*='联系人']", ".boss-search-input", "[class*='search'] input"],
    tabs: [".chat-tab", "[class*='chat-tab']"],
    panel: [".chat-panel", ".chat-conversation", "[class*='chat-panel']"],
    emptyState: [".chat-empty", "[class*='empty']"],
  },
  chatOpen: {
    editor: ["#chat-input", "[contenteditable='true']", ".chat-input"],
    sendButton: [".btn-send", "button[class*='send']", "[class*='send'] button"],
    header: [".chat-conversation .header", "[class*='chat'] [class*='header']", ".friend-header"],
    jobLinkInChat: ["a[href*='/job_detail/']"],
    jobCardInChat: ["[class*='job']", "[class*='position']"],
    outgoing: [
      "[class*='msg'] [class*='self']",
      "[class*='message'] [class*='self']",
      "[class*='bubble']",
    ],
    messageItem: [".message-item", "[class*='message-item']"],
  },
  guards: {
    geetest: [".geetest_panel", "#geetest", "[class*='geetest']", "[id*='geetest']"],
    captcha: ["[class*='captcha']", "[id*='captcha']"],
    verifyWrap: [".verify-wrap", "[class*='verify-wrap']", "[class*='verify']"],
    loginDialog: [
      ".sign-wrap",
      ".login-register",
      "[class*='login-dialog']",
      "[class*='login-box']",
    ],
    securityPage: [".security", "[class*='security']"],
  },
} as const;

type ProbeGroup = keyof typeof PROBES;

interface ProbeMatch {
  readonly sel: string;
  readonly count: number;
  readonly first: string;
}

async function probe(
  page: Page,
  group: ProbeGroup,
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

/** Deeper, still-local structural dump for one page instance (private evidence). */
const deepCapture = async (page: Page, kind: string): Promise<Record<string, string>> => {
  const grab = async (js: string): Promise<string> =>
    page
      .evaluate(js)
      .then((v) => String(v ?? ""))
      .catch(() => "");
  if (kind === "list") {
    return {
      firstCard: await grab(
        `document.querySelector('.job-card-wrap')?.outerHTML?.slice(0, 4000) ?? ''`,
      ),
      activeCard: await grab(
        `document.querySelector('.job-card-wrap.active')?.outerHTML?.slice(0, 4000) ?? ''`,
      ),
    };
  }
  if (kind === "detail") {
    return {
      bodyClass: await grab(`document.body.className`),
      secInfo: await grab(
        `document.querySelector('.job-sec-info')?.outerHTML?.slice(0, 6000) ?? ''`,
      ),
      sider: await grab(`document.querySelector('.sider')?.outerHTML?.slice(0, 6000) ?? ''`),
      detailOp: await grab(
        `document.querySelector('.job-detail-op')?.outerHTML?.slice(0, 2000) ?? ''`,
      ),
    };
  }
  if (kind === "chatOpen") {
    return {
      conversation: await grab(
        `document.querySelector('.chat-conversation')?.outerHTML?.slice(0, 6000) ?? ''`,
      ),
      firstMessages: await grab(
        `Array.from(document.querySelectorAll('.message-item')).slice(0,8).map(m => m.className + ' | mid=' + m.getAttribute('data-mid')).join('\\n')`,
      ),
      header: await grab(
        `Array.from(document.querySelectorAll('.chat-conversation [class*=header], .chat-conversation [class*=title], .chat-conversation [class*=friend]')).slice(0,6).map(h => h.tagName + '.' + h.className + ' :: ' + h.textContent.trim().slice(0,80)).join('\\n')`,
      ),
    };
  }
  return {};
};

const run = async (): Promise<void> => {
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
  console.log("[recon] login detected. Session mode — waiting for commands in:");
  console.log(`[recon]   ${CMD_DIR}`);
  console.log(
    '[recon] drop <id>.json there; results appear in result/<id>.json. {"op":"done"} exits.',
  );

  // Command loop: the browser NEVER restarts from here on.
  const handled = new Set<string>();
  while (true) {
    let files: string[] = [];
    try {
      files = readdirSync(CMD_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    for (const file of files) {
      if (handled.has(file)) continue;
      handled.add(file);
      const id = file.replace(/\.json$/, "");
      let cmd: { op?: string; kind?: string } = {};
      try {
        cmd = JSON.parse(readFileSync(join(CMD_DIR, file), "utf8"));
      } catch (e) {
        writeResult(id, { error: `bad command json: ${String(e)}` });
        continue;
      }
      try {
        if (cmd.op === "done") {
          writeResult(id, { ok: true });
          console.log("[recon] done received — closing browser.");
          await context.close();
          return;
        }
        if (cmd.op === "url") {
          writeResult(id, { url: page.url(), title: await page.title() });
        } else if (cmd.op === "probe" && isProbeGroup(cmd.kind)) {
          writeResult(id, { url: page.url(), probes: await probe(page, cmd.kind) });
        } else if (cmd.op === "deep" && typeof cmd.kind === "string") {
          writeResult(id, {
            url: page.url(),
            probes: await probe(
              page,
              cmd.kind === "chatOpen" ? "chatOpen" : cmd.kind === "detail" ? "detail" : "list",
            ),
            deep: await deepCapture(page, cmd.kind),
          });
        } else {
          writeResult(id, { error: `unknown op/kind: ${JSON.stringify(cmd)}` });
        }
      } catch (e) {
        writeResult(id, { error: String(e) });
      }
      console.log(`[recon] handled ${file}`);
    }
    await page.waitForTimeout(1000);
  }
};

const isProbeGroup = (v: unknown): v is ProbeGroup =>
  v === "list" || v === "detail" || v === "chat" || v === "chatOpen" || v === "guards";

function writeResult(id: string, data: unknown): void {
  writeFileSync(join(RESULT_DIR, `${id}.json`), JSON.stringify(data, null, 2), "utf8");
}

run().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
