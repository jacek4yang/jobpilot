import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { BOSS_METADATA, createBossPlatform } from "../../Workspace/JobPilot/src/adapters/boss/index";
import { parseBossJobList } from "../../Workspace/JobPilot/src/adapters/boss/parser/list-parser";
import { parseBossJobDetail } from "../../Workspace/JobPilot/src/adapters/boss/parser/detail-parser";
import {
  classifyBySwitch,
  detectBossPageKindFromSignals,
} from "../../Workspace/JobPilot/src/adapters/boss/parser/page-kind";
import type { LogEntry, Logger } from "../../Workspace/JobPilot/src/ports/logger";

const FIX = "D:/Workspace/JobPilot/tests/fixtures/boss";
const logs: LogEntry[] = [];
const mk = (level: LogEntry["level"]) => (c: string, m: string, ctx?: Record<string, unknown>) => {
  logs.push({ timestamp: Date.now(), level, component: c, message: m, ...(ctx ? { context: ctx } : {}) });
};
const logger: Logger = {
  debug: mk("debug"),
  info: mk("info"),
  warn: mk("warn"),
  error: mk("error"),
  entries: () => logs,
  clear: () => {
    logs.length = 0;
  },
};

const load = (file: string, url: string) => {
  const win = new Window({ url });
  win.document.write(readFileSync(`${FIX}/${file}`, "utf8"));
  return win;
};
const docOf = (w: Window) => w.document as unknown as Document;
// biome-ignore lint/suspicious/noExplicitAny: smoke harness only
const nodeOf = (w: Window) => w.document as unknown as any;
const locOf = (w: Window) => w.location as unknown as Location;
const clock = { now: () => 1_700_000_000_000 };

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}`);
  }
};
const platform = (w: Window) =>
  createBossPlatform({ document: docOf(w), location: locOf(w), logger, clock, version: "0.1.0" });

const cases: [string, string, string][] = [
  ["job-list.html", "https://www.zhipin.com/web/geek/job?query=x", "job-list"],
  ["job-detail.html", "https://www.zhipin.com/job_detail/boss-1001.html", "job-detail"],
  ["login.html", "https://www.zhipin.com/web/user/login", "login-required"],
  ["captcha.html", "https://www.zhipin.com/web/geek/job", "captcha"],
  ["empty-list.html", "https://www.zhipin.com/web/geek/job?query=zzz", "empty-result"],
  ["unsupported.html", "https://www.zhipin.com/other", "unknown"],
  ["job-list.html", "https://example.com/list", "unsupported"],
];
for (const [file, url, expected] of cases) {
  const got = platform(load(file, url)).detectPage();
  check(got === expected, `pageKind ${file}@${url} got=${got} want=${expected}`);
  console.log(`${got === expected ? "PASS" : "FAIL"} pageKind ${file} -> ${got} (want ${expected})`);
}

{
  const res = parseBossJobList(nodeOf(load("job-list.html", "https://www.zhipin.com/web/geek/job")), "boss");
  console.log(`PARSE list: jobs=${res.jobs.length} skipped=${res.skipped} considered=${res.considered}`);
  for (const j of res.jobs) {
    console.log(
      `   - id=${j.id} native=${j.idIsPlatformNative} "${j.title}" @ ${j.companyName} | ${j.salaryRaw} | ${j.locationRaw} | ${j.url ?? "(no url)"}`,
    );
  }
  check(res.jobs.length === 4 && res.skipped === 0, "list parse 4/0");
}

{
  const detailWin = load("job-detail.html", "https://www.zhipin.com/job_detail/boss-1001.html");
  const listWin = load("job-list.html", "https://www.zhipin.com/web/geek/job");
  const summary = parseBossJobList(nodeOf(listWin), "boss").jobs[0];
  if (summary === undefined) {
    fail++;
    console.log("FAIL no summary");
  } else {
    const d = parseBossJobDetail(nodeOf(detailWin), summary, clock.now());
    if (d === null) {
      fail++;
      console.log("FAIL detail null");
    } else {
      console.log(
        `PARSE detail: "${d.title}" edu=${d.education} exp=${d.experience} salary=${JSON.stringify(d.salary)}`,
      );
      console.log(`   location=${JSON.stringify(d.location)}`);
      console.log(`   company=${JSON.stringify(d.company)}`);
      console.log(
        `   recruiters=${JSON.stringify(d.recruiters)} reqs=${d.requirements.length} skills=${JSON.stringify(d.skills)}`,
      );
      check(
        d.education === "bachelor" &&
          d.experience === "3-5" &&
          d.salary.parsed &&
          d.location.city === "北京" &&
          d.location.district === "朝阳区" &&
          d.location.businessArea === "望京" &&
          d.requirements.length === 4 &&
          d.skills.length === 3 &&
          d.company.stage === "已上市",
        "detail fields",
      );
    }
  }
}

{
  let mismatches = 0;
  for (let i = 0; i < 256; i++) {
    const s = {
      captcha: (i & 1) !== 0,
      riskControl: (i & 2) !== 0,
      loginRequired: (i & 4) !== 0,
      hasJobDetailRoot: (i & 8) !== 0,
      hasJobListRoot: (i & 16) !== 0,
      cardCount: (i & 32) !== 0 ? 3 : 0,
      emptyResultMarker: (i & 64) !== 0,
      supportedHost: (i & 128) !== 0,
    };
    const a = detectBossPageKindFromSignals(s);
    const b = classifyBySwitch(s);
    if (a.kind !== b.kind || a.reason !== b.reason) {
      mismatches++;
      if (mismatches < 3) console.log("MISMATCH", JSON.stringify(s), JSON.stringify(a), JSON.stringify(b));
    }
  }
  console.log(`CROSS-CHECK 256 combos mismatches=${mismatches}`);
  check(mismatches === 0, "pure-vs-switch agreement");
}

{
  const win = load("job-detail.html", "https://www.zhipin.com/job_detail/boss-1001.html");
  const doc = docOf(win);
  const p = platform(win);
  const summary = parseBossJobList(nodeOf(load("job-list.html", "https://www.zhipin.com/x")), "boss").jobs[0];
  if (summary === undefined) {
    fail++;
    console.log("FAIL summary missing for apply");
  } else {
    const detail = parseBossJobDetail(doc, summary, clock.now());
    if (detail === null) {
      fail++;
      console.log("FAIL detail missing for apply");
    } else {
      const r1 = await p.apply(detail);
      console.log(`APPLY (hidden marker) -> ${r1.outcome.kind}`);
      check(r1.outcome.kind === "needs-confirmation", "apply needs-confirmation");
      const v1 = await p.verifyApplication(detail);
      console.log(`VERIFY (hidden marker) -> ${v1.outcome.kind}`);

      doc.querySelector("[data-jobpilot-state='applied']")?.removeAttribute("hidden");
      const r2 = await p.apply(detail);
      console.log(`APPLY (marker visible) -> ${r2.outcome.kind}`);
      check(r2.outcome.kind === "submitted", "apply submitted");
      const v2 = await p.verifyApplication(detail);
      console.log(`VERIFY (marker visible) -> ${v2.outcome.kind}`);
      check(v2.outcome.kind === "confirmed", "verify confirmed");
    }
  }
}

{
  const p = platform(load("captcha.html", "https://www.zhipin.com/web/geek/job"));
  const jobs = await p.scanJobs();
  console.log(`SCAN on captcha -> ${jobs.length} jobs`);
  check(jobs.length === 0, "captcha scan empty");
}
{
  const p = platform(load("unsupported.html", "https://www.zhipin.com/other"));
  const summary = parseBossJobList(nodeOf(load("job-list.html", "https://www.zhipin.com/x")), "boss").jobs[0];
  let threw = false;
  if (summary !== undefined) {
    try {
      await p.loadJob(summary);
    } catch {
      threw = true;
    }
  }
  console.log(`loadJob on unknown page threw = ${threw}`);
  check(threw, "loadJob throws on unknown");
}
{
  const p = platform(load("job-list.html", "https://www.zhipin.com/web/geek/job"));
  const controller = new AbortController();
  controller.abort();
  let threw = false;
  try {
    await p.scanJobs({ signal: controller.signal });
  } catch {
    threw = true;
  }
  console.log(`scanJobs with aborted signal threw = ${threw}`);
  check(threw, "abort honoured");
}

console.log(`\n=== TOTAL pass=${pass} fail=${fail} ===`);
console.log(`automationVerified=${BOSS_METADATA.automationVerified}`);
process.exit(fail === 0 ? 0 : 1);
