# BOSS reference analysis

Engineering notes from studying three reference implementations before extending
JobPilot. The purpose is to extract *behaviour* worth preserving and to record
what must explicitly NOT be copied.

Sources:

| # | Source | What it is | Retrieval |
|---|--------|-----------|-----------|
| 1 | `eatmoreduck/boss-zhipin-scraper` @ `master` | Python/Chrome-CDP job scraper, 1.4k stars | **retrieved via GitHub API** (README, `job_summary.py`, `data/city_codes.json`) |
| 2 | `criscool/boss-helper` @ `master` | Userscript, 48 stars, v0.1.0 | **retrieved via GitHub API** (`boss-helper.user.js`, core tests, success-modal fixture) |
| 3 | `C:\Users\20220\Downloads\boss (2).txt` | "BOSS Helper" v0.3.0, 1802-line userscript | **read in full locally** |

Retrieval note: `raw.githubusercontent.com` is unreachable from this
environment (DNS failure); files were fetched through the GitHub contents API
and decoded from base64. Everything stated below is grounded in retrieved
content. `criscool/boss-helper` v0.1.0 is the ancestor of source 3 — identical
function names, defaults (`intervalSeconds: 60`, `dailyMax: 150`), storage keys
and risk-text list — so sources 2 and 3 are treated as one lineage, with
source 3 being the newer version that adds the communicate/chat layer.

Source 3 is the most directly relevant: it is a working userscript solving the
same problem in the same runtime, and its author clearly thought hard about
exactly the failure modes that matter for safe communication automation.

JobPilot remains an independent design. Nothing below is copied verbatim; the
value is in the invariants, not the code.

---

## 0. Source 1 — `boss-zhipin-scraper`: adopt the data model, reject the architecture

**The architecture must be explicitly rejected.** The repository's own README
states the tool connects to an already-logged-in Chrome over CDP to "reuse a
real fingerprint" and calls the in-page search API directly, "bypassing the
front-end font-based anti-scraping", with the stated benefit that it is "harder
to flag as automated traffic". A documented "Why not Selenium/Playwright"
section frames heavier instrumentation as *more* detectable, i.e. the design
goal is detectability minimisation.

JobPilot must not adopt CDP, remote debugging, an isolated/private browser
profile, login-state copying (`--copy-login-state`), font-deobfuscation, or any
mechanism whose purpose is to evade automated-traffic detection. JobPilot runs
in the user's own normal BOSS tab using the same DOM the user sees.

What *is* worth adopting is the **data model and vocabulary**, which is exactly
the part that transfers without the evasion:

**City table (adopted, vendored).** `data/city_codes.json` is a complete
374-entry map of Chinese city name → 9-digit BOSS city code, including `全国`
and prefecture/county-level entries (e.g. `楚雄彝族自治州`, `昌江黎族自治县`).
Every value conforms to `^\d{9}$`. This directly satisfies the brief's
"arbitrary BOSS-supported cities" requirement without guessing, and is the
single most reusable artifact across all three sources.

**Unknown-city policy (adopted).** The README documents that an unrecognized
city name "now exits with an error instead of silently producing zero results".
This is precisely the brief's "Unknown cities must fail explicitly. Never
silently convert an unknown city into a default city." A good rule independently
arrived at.

**Education vocabulary (adopted).**

```
初中及以下 / 中专/中技 / 高中 / 大专 / 本科 / 硕士 / 博士 / 学历不限
```

**Experience classification (adopted).** A tag is an experience tag if it
contains `年` or is one of `应届` / `在校生` / `经验不限` / `不限经验`.

**Noise filtering (adopted).** Tags equal to `BOSS直聘` / `boss` / `BOSS` /
`来自BOSS直聘` are dropped from skill tags; experience and degree tags are also
excluded from the skill list.

**Location parsing (adopted).** Location splits on `·`; the second part is the
district, falling back to the first.

**Filter dimensions (adopted as SearchProfile fields).** Documented CLI
filters: `--scale --salary --experience --degree`, plus funding stage and
industry. These confirm the dimension set a serious user expects, and map onto
the brief's `SearchProfile`.

**Tag splitting (adopted).** Tags arrive as a `｜`/`|`-separated string or an
array; normalise both.

**Deduplication (adopted conceptually).** Records are deduped by `job_id`,
which reinforces job-id-first identity.

### Source 1 — explicitly do-not-copy

1. CDP / remote debugging / instrumented browser control.
2. Isolated or copied browser profiles; `--copy-login-state`.
3. Font anti-scraping circumvention, or calling undocumented in-page APIs.
4. Any design goal expressed as "harder to flag as automated traffic".
5. DOM fallback enabled by default (they default it *off* because salaries may
   be unreliable — a sound instinct; JobPilot never fabricates a salary).


---

## 1. Source 3 — `boss (2).txt` (BOSS Helper v0.3.0)

### 1.1 Useful ideas worth adopting

**Outgoing-message counting as the success signal.**
Success is never inferred from a toast or a modal. It is confirmed by counting
occurrences of the sent phrase in the outgoing-message region and requiring the
count to exceed the pre-send count:

```js
outgoingPhraseCount(current, phraseText) > (task.beforeCount || 0)
```

This is the single most important idea in the file. A DOM confirmation that
cannot be observed is treated as failure, not success.

**Never re-click after an ambiguous send.**
Before sending, the task is persisted with `status: "sending"` and
`sendAttemptedAt`. If the page reloads in that state, the code path *only
verifies* and never clicks again:

```js
if (task.status === "sending") {
  // A reload after the send click has an unknown outcome. Never click twice.
  await waitForTask(task, () => outgoingPhraseCount(...) > (task.beforeCount || 0), ...);
}
```

This is exactly the "transactional communication" model the product brief asks
for, already validated in practice. JobPilot should formalise it as a persisted
`CommunicationIntent`.

**Task cancellation sentinel.**
Every mutation re-reads the persisted task and refuses to continue if it was
replaced or cancelled:

```js
function updatePending(task, changes) {
  const current = readPending();
  if (!current || current.id !== task.id || current.cancelled) {
    throw new Error("本次常用语任务已取消或被替换");
  }
  ...
}
```

A stale async callback cannot silently resurrect a cancelled transaction.

**Chat identity verification with a stability window.**
The chat must match the queued job's identity (job id → title → company →
recruiter) *and* the header must be unchanged for `chatStableMs` before any
action. Identity matching degrades gracefully:

```js
function targetMatchesChat(target, chat) {
  const comparableId = Boolean(target.jobId && chat.jobIds.length);
  if (comparableId && !chat.jobIds.includes(target.jobId)) return false;
  if (company && !text.includes(company)) return false;
  if (boss && !text.includes(boss)) return false;
  if (comparableId) return true;
  return Boolean(title && text.includes(title) && (company || boss));
}
```

A job-ID match is authoritative; otherwise title *plus* (company or recruiter)
is required. A bare editor presence never authorises a send.

**Editor re-validation immediately before and after every step.**
The draft check runs three times: before claiming the task, after opening the
phrase panel, and after filling — *plus* a check that the filled text is still
intact before clicking send:

```js
if (normalizeTextValue(readEditor(chat.editor)) !== normalizeTextValue(filledText)) {
  throw new Error("输入框内容已改变，已取消本次发送");
}
```

**Read-only activity parsing, recruiter-scoped, conservative on conflict.**
Activity is read only from recruiter-specific containers, never from the whole
document, and contradictory labels resolve to the *least* active:

```js
// 多个矛盾标记同时存在时，采用较不活跃的状态。
return values.sort((a, b) => b.days - a.days || Number(a.online) - Number(b.online))[0];
```

**Detail-panel identity check before trusting detail data.**
Before reading BOSS activity from the detail panel, it verifies the panel
actually belongs to the current card (by job id, or title+company), to avoid
carrying over the previous job's activity badge.

**Cross-tab exclusion via `navigator.locks`.**
`navigator.locks.request(name, { ifAvailable: true }, ...)` — if the lock is
held, the tab does nothing. Combined with a persisted task carrying
`sourceTabId` / `consumerTabId`.

**Tab identity with a bounded fallback.**
`GM_getTab`/`GM_saveTab` with a 1.5s timeout falling back to a
`sessionStorage` id, so UI rendering never blocks on a callback that may never
arrive.

**Risk text detection returning a typed block.**
A centralised `RISK_TEXTS` list, checked before and after navigation, with
`errorStop` on detection — no attempt to dismiss or bypass.

**Conservative minimum interval with user-visible countdown.**
`intervalSeconds` counts down visibly, checking the running flag each second so
a stop takes effect immediately.

### 1.2 Reusable concepts

- Transactional send with a persisted intent and an explicit `sendAttempted`
  marker.
- Multi-signal chat/job identity matching with a documented precedence order.
- Success = observed outgoing-message delta, never a UI toast.
- Draft preservation as a hard invariant checked at multiple points.
- Distinct state for "action attempted, outcome unknown" (their `sending`).
- Screened activity parsing (scoped, conservative on conflict).
- Cross-tab lock plus per-task tab ownership.
- Detail-identity verification before reading detail-scoped data.

### 1.3 Fragile assumptions

- **Broad `[class*='...']` selectors.** `[class*='job-card']`,
  `[class*='btn']`, `[class*='dict-pop']` will match unrelated elements and
  break silently when BOSS renames classes. JobPilot should use ordered
  candidates with explicit confidence levels, preferred semantic anchors first.
- **Text-substring action classification.** `value.includes("立即沟通")`
  will match that string inside any container, including a recommendation card
  or an unrelated dialog. JobPilot must additionally require the element to sit
  inside the *active job detail root* with a matching identity.
- **Fixed sleeps as the primary synchronisation.** `detailWaitMs`,
  `chatWaitMs`, `scrollWaitMs` are wall-clock guesses. JobPilot should prefer
  predicate-based waiting with explicit timeouts (`waitFor`), keeping sleeps
  only as bounded fallbacks.
- **Global document scans.** `document.querySelectorAll` over broad selector
  sets on every tick. Should be scoped to a resolved root and cached.
- **Whole-page risk text scanning.** `containsRiskText` on any text can
  false-positive on a job description mentioning "验证". Should be scoped to
  banner/dialog regions.
- **Chat root discovery by walking up to `document.body`.** The heuristic that
  stops at the contact-search input is clever but brittle; a bounded ancestor
  walk with an explicit bound is safer.

### 1.4 Unsafe or incorrect patterns

- `state.scriptClick` distinguishes script clicks from user clicks, but nothing
  in the reviewed paths consumes it to *yield* to the user. The brief's
  "manual interaction detection" requirement is only partially met.
- `markStats("success")` is called when no phrase task was armed, i.e. "clicked
  communicate" is counted as success without verifying the contact actually
  happened.
- Activity label "未知" is a skip-or-pass decision driven by a setting rather
  than by evidence; combined with the whole-document scan this can pass an
  unknown-activity job when the user expected strictness.
- The interval sleep loop is driven by `mode`, but `processJobCard` re-checks
  `state.mode !== MODE.running` in several places — a hint that the author
  found races between the loop and user stop. JobPilot should model this in the
  reducer rather than with scattered flag checks.

### 1.5 UX lessons

- A 60s default interval with a live countdown is respectful and predictable.
- Chinese status labels (`运行中`, `已停止`, `异常停止`) are the right register
  for the target user.
- Rich skip *reasons* (`跳过：命中排除词：销售`) are far more useful than a
  silent skip counter.
- `maxConsecutiveFailures` with automatic stop prevents a broken selector set
  from grinding through the whole queue.

### 1.6 DOM / parser lessons

- `jobIdFromUrl` prefers `/job_detail/<id>.html` from `encryptJobId`, then
  `jobId` query params, then `data-jobid`/`data-job-id` attributes. Good
  precedence; matches JobPilot's identity priority.
- `identityText` normalises company suffixes (`股份有限公司` etc.) before
  comparison — a genuinely useful normalisation JobPilot should adopt.
- Reading outgoing messages requires a dedicated selector group; there is no
  reliable generic signal.

### 1.7 State-management lessons

- The `pending` / `runner` split — a *task* (what must happen) separate from a
  *runner* (which tab is driving, and where to return) — is a good separation
  of concerns worth mirroring conceptually.
- Statuses `waiting → claimed → sending → sent/failed` plus a `cancelled`
  flag map cleanly onto the brief's communication phases.

### 1.8 Persistence lessons

- Keys: `bossHelper.settings`, `bossHelper.stats`, `bossHelper.logs`,
  `bossHelper.pendingPhrase.v2`, `bossHelper.runner.v2.<tabId>`,
  `bossHelper.tabId.v2` (sessionStorage).
- Stats reset by day key (`todayKey`), with `shouldResetStats` on load.
- A `v2` suffix in the key names is a crude schema-versioning mechanism;
  JobPilot's `PersistedRoot.schemaVersion` + migrations is the better approach.

### 1.9 Things JobPilot should explicitly NOT copy

1. Any `[class*='...']` wildcard selector as a primary anchor.
2. Unscoped text matching for action classification or risk detection.
3. Fixed sleeps as the primary wait mechanism.
4. Counting "clicked communicate" as success without verification.
5. Unbounded DOM walks (`while (root.parentElement)`).
6. Key-name version suffixes instead of real migrations.
7. Stat counters that survive a day boundary without explicit reset testing.
8. A `cancelled` boolean on a mutable persisted object as the only
   cancellation mechanism (JobPilot uses a typed intent with an explicit
   `uncertain` phase).
9. Monolithic 1800-line single-file structure.
10. Implicit global mutable `state` object mutated from async callbacks.

---

## 2. Cross-cutting conclusions for JobPilot

### 2.1 Invariants to preserve (from the brief, validated by source 3)

| Invariant | How source 3 handles it | How JobPilot should handle it |
|---|---|---|
| Never send into an unverified chat | `targetMatchesChat` + stability window | Same, plus require active-detail-root context |
| Never overwrite a user draft | `readEditor` checked 3× | Same, as a typed `DRAFT_PRESENT` failure |
| Never send twice after an uncertain outcome | `status: "sending"` verify-only path | Persisted `CommunicationIntent.phase = "send-attempted"` |
| Never continue if the chat changed | `assertSameChat` on every step | Same, as a precondition in the reducer |
| Never continue through CAPTCHA/login/risk | `detectRiskOrLoginBlock` + `errorStop` | Typed `BlockReason`, fail closed |
| Never treat an unknown modal as success | `findUnknownBlockingModal` | Explicit `UNKNOWN_MODAL` taxonomy entry |
| Never count success without confirmation | Outgoing-count delta | Same; `verified` requires observed evidence |

### 2.2 Architecture consequences

The reference is a single 1800-line IIFE with a mutable global `state` and
implicit coupling between DOM helpers and control flow. JobPilot's existing
hexagonal split (domain / application / ports / adapters) is the right
structure to express the same behaviour testably, and the new work should
extend it rather than replace it:

- The communication transaction belongs in `domain/communication`, expressed as
  a pure phase machine — no DOM.
- The chat/job identity matching is pure logic and belongs in the domain,
  taking plain text/ids as input so it is unit-testable without a DOM.
- The BOSS-specific editor/panel/message selectors and interactions belong in
  `adapters/boss/communication`.
- Cross-tab ownership belongs behind a `Lock` port with a `navigator.locks`
  implementation, so tests can substitute a deterministic fake.

### 2.3 Where source 3 is stronger than the current JobPilot baseline

- It has a real, working communication transaction; JobPilot currently stops at
  "apply".
- It has draft protection and chat identity verification; JobPilot has neither.
- It has cross-tab locking; JobPilot has none.
- It has recruiter-activity parsing; JobPilot has no activity model.

### 2.4 Where the current JobPilot baseline is stronger

- Typed, versioned config with runtime validation and migrations.
- A pure reducer with an explicit effect model, unit-tested.
- Least-privilege grants (source 3 requests `GM_getTab`/`GM_saveTab`).
- Structured redacted logging rather than an unbounded log array.
- A build with a single verified artifact and a build-verification script.
- Explicit fail-closed taxonomy rather than string-matched risk text.

---

## 3. Detailed reports for sources 1 and 2

Both repositories were retrieved directly (see the retrieval note above), so the
findings in sections 0 and 1 are grounded in fetched source rather than
second-hand summaries. A dedicated research agent was also dispatched per
repository and independently reached the same conclusion about source 1's
architecture. Where agent output and my own reading of the fetched files
disagreed, the fetched file won.

Nothing in this document depends on agent output that I could not verify against
retrieved content.

**Retrieval honesty summary:**

| Claim source | Verified how |
|---|---|
| Source 1 data model, city table, vocabularies, CLI flags | Fetched `city_codes.json`, `job_summary.py`, `README.en.md` via GitHub API |
| Source 1 CDP / anti-scraping architecture | Source 1's own README text, quoted |
| Source 2 function inventory, defaults, storage keys, fixture | Fetched `boss-helper.user.js`, its core test file, and its modal fixture |
| Source 3 all behavioural claims | Read in full from local disk, line-referenced |
| Live BOSS DOM behaviour | **NOT verified.** No live site was inspected. All BOSS selectors remain fixture-only or unverified. |

### Source 2 — `criscool/boss-helper` specifics

v0.1.0 lineage details worth recording, since they define the migration target
for the brief's "import old BOSS Helper settings" requirement:

- Storage keys: `bossHelper.settings`, `bossHelper.stats`, `bossHelper.logs`.
- Defaults: `intervalSeconds: 60`, `dailyMax: 150`, `detailWaitMs: 2000`,
  `modalWaitMs: 5000`, `scrollWaitMs: 2500`, `maxConsecutiveFailures: 3`.
- Stock include keywords are QA/testing-specific
  (`测试开发,测试工程师,软件测试,自动化测试,测开,QA,质量`) and stock excludes are
  sales-role-specific (`网络销售,电话销售,销售,客服,...`). The brief correctly
  forbids shipping these as JobPilot's universal defaults; they are migration
  input only.
- Grants requested: `GM_getValue`, `GM_setValue`, `GM_deleteValue`,
  `GM_registerMenuCommand` — the same least-privilege set JobPilot uses. Source
  3 adds `GM_getTab`/`GM_saveTab`, which JobPilot avoids by using
  `navigator.locks` + a storage-backed tab id instead.
- It ships a **success-modal fixture** asserting the real dialog vocabulary:
  `已向BOSS发送消息`, `留在此页`, `继续沟通`. This is the closest thing to
  real-site evidence in any source and is the basis for JobPilot's own
  success-modal fixture.
- It ships a `vm`-sandbox test harness that exposes a `__BOSS_HELPER_TESTS__`
  API when a global flag is set. JobPilot rejects this pattern: production code
  must not carry a test-only export path. JobPilot's modules are imported
  directly by Vitest instead.

