# Architecture

JobPilot is a hexagonal (ports and adapters) TypeScript application that is
bundled into a single userscript. This document describes the layering rules, the
real module inventory, the state and effect model, persistence, the multi-tab
design, and the testing strategy.

---

## 1. Layers and the dependency rule

```
              ┌─────────────────────────────────────────┐
              │                  UI                     │
              │        src/ui/panel.ts, sections.ts     │
              └────────────────────┬────────────────────┘
                                   │ view models + callbacks
                                   v
              ┌─────────────────────────────────────────┐
              │             APPLICATION                 │
              │  controller · reducer · orchestrator    │
              │  state · events · discovery · history   │
              └────────────────────┬────────────────────┘
                                   │
                                   v
              ┌─────────────────────────────────────────┐
              │                DOMAIN                   │
              │  rules · engine · matching · job ·      │
              │  communication/intent · application     │
              └─────────────────────────────────────────┘
                     ^                          ^
                     │ implements               │ implements
              ┌──────┴───────┐           ┌──────┴────────┐
              │   ADAPTERS   │           │ INFRASTRUCTURE│
              │ boss · storage│          │ logs · observer│
              │              │           │ queue · retry  │
              └──────┬───────┘           └──────┬─────────┘
                     │                          │
                     └────────────┬─────────────┘
                                  v
                         ┌─────────────────┐
                         │      PORTS      │
                         │ JobPlatform ·   │
                         │ Storage · Lock ·│
                         │ Logger          │
                         └─────────────────┘
```

### The rules

**R1 — UI → Application → Domain.** Imports point one way only. The panel renders
a `PanelViewModel` and reports intent through `UiCallbacks`; it imports nothing
from `application/`, `adapters/` or `ports/`. Verified by
`src/ui/panel.ts`'s only non-UI import being `./styles` and `./view-model`.

**R2 — Adapters → Ports ← Application.** An adapter implements an interface a port
declares. The application layer depends on the port type, never on an adapter
module. `src/application/orchestrator.ts` imports `JobPlatform` from
`src/ports/job-platform.ts`; it never imports `src/adapters/boss`.

**R3 — The domain is pure.** Nothing under `src/domain/` imports a DOM global, a
storage API or a logger. `Clock` and `Random` arrive as injected interfaces
(`src/domain/support/shared.ts`) so that `Date.now()` and `Math.random()` are not
called inside the domain.

**R4 — One composition root.** `src/bootstrap/container.ts` is the only module
that constructs concrete adapters (`createBossPlatform`, `GMStorage`,
`MemoryStorage`) and binds them. `src/bootstrap/bootstrap.ts` wires the
application together. Nothing else calls a constructor for an adapter.

**R5 — Entry point is trivial.** `src/main.ts` is three lines: import
`bootstrap` and call it. All wiring lives in `bootstrap/`.

**R6 — Ports carry no implementation.** `src/ports/*.ts` contains types and one
small exception: `createMemoryLock` lives in `src/ports/lock.ts` so the
deterministic test double ships next to the interface it satisfies.

---

## 2. Module inventory

### Domain — `src/domain/`

Pure logic. No I/O, no DOM, no globals.

| Module | Responsibility |
| --- | --- |
| `job/job.ts`, `job/index.ts` | `JobSummary`, `JobDetail` and their construction |
| `job/location.ts` | `parseLocation`; total, so there is no failure path — an empty match yields an unknown city rather than a wrong one |
| `job/salary.ts` | `parseSalary`; fails soft, so `salary.parsed === false` means "do not hard-reject" |
| `rule.ts` | `Rule`, `RuleResult`, `RuleReason`, `Evaluation`, `RuleEngineConfig`, and the `rejection` / `hardPass` / `softScore` constructors |
| `engine.ts` | `createRuleEngine`: hard rules first with short-circuit, then soft rules contributing clamped score |
| `hard-filters.ts` | The concrete hard rules (dedup, blacklists, cities, salary band) |
| `scoring-rules.ts` | The concrete weighted soft rules |
| `rules-index.ts` | Ordered registry of the rules the engine runs |
| `matching/two-stage.ts` | `evaluateStageA` (card data only) and `evaluateStageB` (detail required), plus `SCORE_WEIGHTS` |
| `search-profile/profile.ts` | `SearchProfile`, `ActivityPreference` |
| `recruiter/recruiter.ts`, `recruiter/activity.ts` | Recruiter model and `evaluateActivity`, conservative on contradictory labels |
| `company/company.ts` | Company scale, industry, funding stage |
| `application/application.ts` | `ApplicationRecord`, `ApplicationStatus`, `canTransitionTo`, `applyTransition`, `isSubmissionFinal` |
| `history/job-history.ts` | Job-history helpers over records |
| `communication/identity.ts` | `matchChatIdentity`, `normalizeIdentityText`, `isSameConversation`, `countOutgoingMessages` |
| `communication/intent.ts` | `CommunicationIntent`, `IntentPhase`, `reduceIntent`, `canClickSend`, serialization |
| `communication/template.ts` | Message template rendering |
| `support/ids.ts`, `support/shared.ts` | Branded `JobId`/`PlatformId`; `Clock`, `Random` interfaces |

`communication/intent.ts` is the most safety-critical module in the codebase.
`canClickSend` is the single guard every send path consults:

```ts
export const canClickSend = (intent: CommunicationIntent): boolean =>
  intent.phase === "prepared" && intent.sendAttemptedAt === undefined;
```

### Ports — `src/ports/`

| Module | Interface |
| --- | --- |
| `job-platform.ts` | `JobPlatform` (`detectPage`, `scanJobs`, `loadJob`, `apply`, `verifyApplication`) plus `PageKind`, `ApplyOutcome`, `VerificationOutcome`, `BlockReason`, `LocatedElement` |
| `storage.ts` | `Storage` (`get`, `set`, `delete`, `keys`) |
| `lock.ts` | `Lock` (`acquire`, `renew`, `release`, `currentHolder`), `LockHandle`, `AcquireResult`, `createMemoryLock`, `DEFAULT_LOCK_TTL_MS`, `DEFAULT_LOCK_HEARTBEAT_MS` |
| `logger.ts` | `Logger`, `LogEntry`, `LogLevel`, and `redact` / `SENSITIVE_KEYS` |
| `index.ts` | Barrel re-export so consumers import one path |

### Application — `src/application/`

| Module | Responsibility |
| --- | --- |
| `state.ts` | `AutomationState`, `AutomationContext`, `PauseReason`, `describePauseReason`, `SessionStats`, `ACTIVE_STATES` |
| `events.ts` | `AutomationEvent` (the reducer's only input) and `Effect` (the reducer's only output) |
| `reducer.ts` | `reduce(context, event, options) -> { context, effects }`. Pure |
| `controller.ts` | Drives the reducer, runs effects through the orchestrator, keeps the watchdog in sync, avoids re-entrancy |
| `orchestrator.ts` | Performs the I/O each `Effect` implies, and dispatches the resulting events |
| `discovery.ts` | `createDiscoveryService`: profile → stage A → stage B → matches. Never enqueues |
| `history.ts` | `ApplicationHistory`: the authoritative record; `submittedJobIds()` is what prevents a duplicate submission |
| `repository.ts` | The single storage key `jobpilot:root:v1`; every read goes through migration then validation |
| `communication-runner.ts` | `createCommunicationRunner`: drives one `CommunicationIntent` through the adapter. The only module permitted to click send, at most once |

### Adapters — `src/adapters/`

| Module | Responsibility |
| --- | --- |
| `boss/index.ts` | `createBossPlatform`, `BOSS_METADATA`, `BOSS_PLATFORM_ID` |
| `boss/selectors.ts` | Every selector, with `confidence` and `note` |
| `boss/guards.ts` | Fail-closed detection: captcha, risk control, login, empty result, host support |
| `boss/parser/page-kind.ts` | The `PageKind` precedence chain and the DOM-free signal classifier |
| `boss/parser/list-parser.ts` | Card → `JobSummary`; skips bad cards rather than throwing |
| `boss/parser/detail-parser.ts` | → `JobDetail`; returns `null` when a required anchor is missing |
| `boss/actions/apply-action.ts` | The three apply rules; guard re-check, listed selectors only, never infer success |
| `boss/actions/abort.ts` | `AbortSignal` helpers |
| `boss/communication/selectors.ts` | Communication selector registry with the same confidence vocabulary |
| `boss/communication/chat-reader.ts` | Pure readers over the chat DOM |
| `boss/communication/communication-action.ts` | `prepareMessage`, `dispatchSend`, `observeSend` |
| `boss/communication/write-editor.ts` | Writes text into a `textarea` or a `contenteditable` |
| `boss/communication/job-id.ts` | `extractJobIds`, `isPlausibleJobId` |
| `boss/communication/index.ts` | Public surface of the communication flow |
| `boss/data/city-codes.ts` | Vendored name → 9-digit code table (377 entries) |
| `boss/data/city-resolver.ts` | `resolveCityCode`; fails explicitly, no default city |
| `boss/diagnostics/boss-diagnostics.ts` | Redacted snapshot |
| `storage/gm-storage.ts` | `Storage` over `GM_getValue`/`GM_setValue`/`GM_deleteValue` |
| `storage/memory-storage.ts` | `Storage` in memory, for tests and for a host without GM grants |

### Infrastructure — `src/infrastructure/`

**Nothing in the application layer imports infrastructure yet.** It is complete
and unit-tested, and it is the intended source of the timers, pacing and
observation the runtime will use.

| Module | Responsibility |
| --- | --- |
| `logging/logger.ts` | `createLogger`: bounded ring buffer, redaction, level filtering |
| `observer/page-observer.ts` | SPA lifecycle: patched `history` + `popstate` + debounced `MutationObserver` + a URL poll fallback, all torn down by one `AbortController` |
| `queue/queue.ts` | Ordered work queue |
| `rate-limit/rate-limiter.ts` | `nextDelayMs`, `evaluateSessionLimits` |
| `retry/retry.ts` | Bounded retry with backoff |
| `watchdog/watchdog.ts` | `createWatchdog` and `DEFAULT_WATCHDOG_BUDGETS`; reports a stalled state a bounded number of times |

### UI — `src/ui/`

| Module | Responsibility |
| --- | --- |
| `view-model.ts` | `PanelViewModel`, `PanelTab`, `SafetyLevel`, `PendingDecisionView`, `safetyFromState` |
| `panel.ts` | `createPanel`: open shadow root, launcher, tab strip, chips, toasts, action buttons |
| `sections.ts` | `buildSections` — pre-rendered section DOM per tab |
| `styles.ts` | `PANEL_CSS`, every rule scoped under `.jobpilot-` |

### Bootstrap — `src/bootstrap/`

| Module | Responsibility |
| --- | --- |
| `container.ts` | The composition root. Detects GM availability, falls back to memory storage, constructs the platform, logger and engine |
| `bootstrap.ts` | The lifecycle: load config → build panel → build controller and orchestrator → attach observers → dispose as one unit |

---

## 3. State machine and the effect model

### 3.1 Shape

`src/application/state.ts` defines eleven explicit states:

```
idle · scanning · evaluating · opening · validating
applying · verifying · cooldown · paused · blocked · failed
```

`ACTIVE_STATES` is the subset in which work is genuinely in flight
(`scanning`, `evaluating`, `opening`, `validating`, `contacting`, `cooldown`). The
watchdog only runs while the machine is in one of them.

### 3.2 The reducer is pure and total

```ts
export const reduce = (
  context: AutomationContext,
  event: AutomationEvent,
  options: ReduceOptions,
): ReduceResult
```

`ReduceResult` is `{ context, effects }`. The reducer never performs I/O; it
returns `Effect` values that the controller hands to the orchestrator. It never
throws: an event that is illegal for the current state returns the context
unchanged, so a late async callback from a previous phase cannot push a completed
transaction backwards.

### 3.3 Events and effects

`src/application/events.ts` is the complete vocabulary.

**Events in:** `START`, `PAUSE`, `RESUME`, `STOP`, `SCAN_STARTED`,
`SCAN_COMPLETED`, `SCAN_FAILED`, `JOB_LOADING`, `JOB_LOADED`, `JOB_LOAD_FAILED`,
`EVALUATED`, `CONTACT_STARTED`, `CONTACT_CONFIRMED`, `CONTACT_SKIPPED`,
`CONTACT_UNCERTAIN`, `BLOCKED`,
`COOLDOWN_ELAPSED`, `RETRY_ELAPSED`, `QUEUE_CHANGED`, `PAGE_CHANGED`,
`WATCHDOG_TIMEOUT`, `SESSION_LIMIT_REACHED`, `CLEAR_ERROR`.

**Effects out:** `scan-jobs`, `load-job`, `evaluate-job`, `contact-job`,
`schedule-cooldown`, `notify`, `persist`,
`record-diagnostics`, `stop`.

Both unions end in an exhaustiveness guard, so adding a variant without handling
it is a compile error.

### 3.4 The single fail-closed path

Every safety signal funnels through one private helper:

```ts
const blockFor = (context, reason, now): ReduceResult => { /* -> "paused" */ };
```

CAPTCHA, risk control, expired login, unknown DOM, ambiguous outcome, watchdog
stall, session limit and page change all call it. It sets `pauseReason` and
`lastMessage`, and emits `notify` + `record-diagnostics` + `persist`. One code
path means one behaviour to test.

`RESUME` always restarts from `scanning`; the machine never resumes mid-action,
because a half-completed communication must be re-verified from the top.

### 3.5 Controller: re-entrancy and effect ordering

`src/application/controller.ts` handles one subtlety explicitly. Effects dispatch
follow-up events, so a naive implementation recurses. The controller guards with
a `draining` flag: a `dispatch` that arrives while draining is pushed onto a
`pending` array, and the outer loop concatenates it and iterates. The queue is
drained iteratively, never recursively.

If an effect throws, the controller logs it and dispatches `PAUSE` with reason
`ambiguous-state` — an effect failure takes the same fail-closed path as any
other safety signal.

The watchdog is kept in sync on every state change: `watch(state)`, then
`start()` when the new state is active and `stop()` otherwise.

### 3.6 Watchdog budgets

`DEFAULT_WATCHDOG_BUDGETS` gives each active state a wall-clock budget:

| State | Budget |
| --- | --- |
| `scanning` | 30 s |
| `evaluating` | 10 s |
| `opening` | 30 s |
| `validating` | 10 s |
| `applying` | 45 s |
| `verifying` | 30 s |
| `cooldown` | 120 s |

A stall is reported at most twice per state (`maxStallsPerState` defaults to 2),
then the watchdog stops nagging and waits for the machine to fail closed on its
own. There are no infinite retry loops.

### 3.7 The communication transaction

`src/domain/communication/intent.ts` is a second, independent machine with eight
phases:

```
armed → navigating → chat-verified → prepared
      → send-attempted → { verified | uncertain | failed }
```

- `SAFE_TO_ABANDON` = `armed`, `navigating`, `chat-verified`, `prepared`.
- `TERMINAL_PHASES` = `verified`, `uncertain`, `failed`.
- `send-attempted` is the point of no return. `SEND_DISPATCHED` is the only event
  that produces it, and it is only legal when `canClickSend` says so — which is
  only from `prepared` with `sendAttemptedAt` unset. After that, `canClickSend`
  is `false` forever.
- `SEND_OBSERVED` with a count *not* exceeding the baseline yields `uncertain`,
  never `failed`. The click may have landed and rendered differently.
- `EXPIRED` before a send abandons safely; `EXPIRED` after a send is `uncertain`.
- `deserializeIntent` returns `undefined` for a malformed record rather than a
  best-effort object, because a corrupt intent must never be able to authorise a
  send.

`src/application/communication-runner.ts` is the only caller allowed to reach the
click. It persists `send-attempted` **before** dispatching the click, so the
window between the two statements is recoverable as `uncertain`.

---

## 4. Persistence

### 4.1 One key

Everything lives under a single key, `jobpilot:root:v1`
(`STORAGE_KEY` in `src/application/repository.ts`). `GMStorage` prefixes keys with
`jobpilot:` so a second userscript cannot collide.

### 4.2 Schema

```ts
export interface PersistedRoot {
  readonly schemaVersion: number;
  readonly config: unknown;        // a validated JobPilotConfig
  readonly applications: unknown;  // serialised ApplicationRecord[]
  readonly statistics: unknown;
}
```

`config`, `applications` and `statistics` are deliberately `unknown`. That means a
migration physically cannot rewrite records it does not understand — it has to
carry them through.

`CURRENT_SCHEMA_VERSION` is `3`.

### 4.3 Load path

`createRepository(storage, logger).load()` runs, in order:

1. `storage.get(STORAGE_KEY)`. Absent → defaults, `fresh: true`.
2. `migratePersistedRoot(raw)`. Failure → defaults plus a warning; the stored
   document is left alone.
3. `validateConfig(migrated.root.config)`. Failure → defaults plus a warning
   listing every problem.
4. `deserializeHistory(migrated.root.applications)`. Malformed records are
   dropped individually, and the count of dropped records is reported.

Every failure path yields a usable default rather than throwing. A userscript
that refuses to start is worse than one that starts with defaults, so failures
become warnings that surface in diagnostics.

### 4.4 Migrations

| Step | What it does |
| --- | --- |
| `v1 → v2` | Moves `minActionDelayMs`, `maxActionDelayMs` and `maxRetries` out of `automation` into a new `rateLimit` section. A value is lifted only when the new section does not already define it |
| `v2 → v3` | Adds `automation.acknowledgeRisks`, defaulting to `false`. A v2 document with `mode: "automatic"` is stepped back to `assist`, because v2 could not have been gated |

The rules:

- **Migrations never silently destroy user data.** History is the only record of
  work actually submitted to an employer; a migration that refuses to run is
  better than one that drops a section it could not parse.
- Every step is additive. Unknown fields pass through untouched; a missing field
  is filled from defaults, never removed.
- A missing `schemaVersion` means v1 by definition. A present-but-non-integer is
  a corrupt document and is refused rather than coerced.
- **A document claiming a newer version is refused outright**, with the data left
  on disk. Guessing at a downgrade would discard fields the build cannot see.
- `MIGRATION_STEPS` is append-only. Never renumber or reuse a step.
- Section-level repair is independent per section, so one corrupt section cannot
  take the user's history down with it.

### 4.5 Validation contract

`src/config/validate.ts` states four rules, in priority order:

1. **Never throw.** Persisted JSON is untrusted: truncated, hand-edited, written
   by a future version, or hostile.
2. **Report everything.** All problems are collected, not just the first.
3. **Missing is fine, wrong is not.** An absent field takes the default; a field
   of the wrong *type* is an error. Coercing `"yes"` into `true` would hide the
   user's real intent.
4. **Conservative on conflict.** `mode: "automatic"` without
   `acknowledgeRisks: true` fails validation rather than downgrading silently, so
   the user sees why.

---

## 5. Multi-tab design

Two BOSS tabs must never drive the same queue.

### 5.1 The port

`src/ports/lock.ts`:

```ts
export interface Lock {
  acquire(options: { ownerId: string; ttlMs: number }): Promise<AcquireResult>;
  renew(options: { token: string; ttlMs: number }): Promise<boolean>;
  release(token: string): Promise<void>;
  currentHolder(): Promise<string | undefined>;
}
```

`acquire` never blocks waiting for a holder. A tab that cannot take the lock must
render read-only rather than queue work it cannot perform.

`AcquireResult` distinguishes `held-by-other` from `unsupported`, so a browser
without `navigator.locks` is a distinct, reportable condition rather than an
assumed failure.

### 5.2 Lease and heartbeat

`DEFAULT_LOCK_TTL_MS` is 30 s and `DEFAULT_LOCK_HEARTBEAT_MS` is 10 s — a 3×
margin between renewal and expiry, so two missed heartbeats are survivable and a
crashed tab's lease is reclaimable within one TTL.

### 5.3 Deterministic tests

`createMemoryLock` takes an injected clock and an optional `seedHolder`, so the
"another tab owns it" path is exercised deterministically with no timing
dependence.

### 5.4 Taking over

Taking over must never replay an ambiguous send. The new owner re-reads the live
`CommunicationIntent` and applies the recovery rule: `send-attempted` becomes
`uncertain` and awaits a human; anything earlier is abandoned safely.

**Implementation status: the port and the memory implementation exist; no
`navigator.locks`-backed implementation is wired into bootstrap.** Multi-tab
exclusion is therefore specified and tested at the port boundary but not yet
active in the running userscript. See Known limitations in the README.

---

## 6. Testing strategy

Three layers, each chosen for the cheapest environment that can genuinely test the
thing.

| Layer | Tool | Environment | What it can prove |
| --- | --- | --- | --- |
| Unit | Vitest | Node | The domain, the reducer, config validation and migrations, the intent machine, identity matching, storage |
| Integration | Vitest | happy-dom | The BOSS adapter's classification and parsers against synthetic fixtures |
| Browser | Playwright | Chromium, loopback only | The built bundle mounts, isolates itself, and fails closed |

### 6.1 Why the domain is testable at all

Every impurity is injected. `Clock` and `Random` are interfaces; the platform,
storage and logger are ports. `createController` takes an `onChange` callback and
an `onPersist` hook, so a test observes transitions without a DOM. The reducer's
effects are data, so a test asserts on the effect list rather than spying on I/O.

### 6.2 The fixture workflow

Fixtures live in `tests/fixtures/boss/` and are **hand-authored to match the
selectors**, not captured from the live site. That is the honest description and
it bounds what a passing test means.

`tests/integration/boss-harness.ts` loads a fixture into a happy-dom `Window` and
handles two environment facts explicitly:

1. happy-dom's `Document.textContent` is always `""`, so `asParseRoot` yields a
   body-shaped view whose `textContent` is real. Otherwise the text fallbacks in
   the guards would pass for the wrong reason.
2. Fixtures written without a doctype are parsed in quirks mode, which drops
   descendant text nodes. `doctype: "parsed"` prepends `<!doctype html>`, matching
   the standards mode the real host serves.

Both workarounds make the test DOM behave like the browser DOM the adapter is
written against; neither changes adapter behaviour.

### 6.3 Why the browser tests can use `www.zhipin.com`

`isSupportedHost` accepts exactly `zhipin.com` and `www.zhipin.com`. That guard is
a deliberate fail-closed safety feature, and the browser tests do not weaken it.

Instead, the harness is served from `http://www.zhipin.com:43117`, and Chromium is
launched per spec with:

```
--host-resolver-rules=MAP www.zhipin.com 127.0.0.1
```

This maps the name onto loopback **before DNS resolution**, so no lookup happens
and no packet leaves the machine, while `location.hostname` really is
`www.zhipin.com`. The production guard, classifier and orchestrator run
unmodified. The alias is set with `test.use({ launchOptions })` inside each spec,
so the shared `playwright.config.ts` is untouched. A dedicated spec loads the
harness from plain `127.0.0.1` to confirm the host guard also fails closed.

`fixture-smoke.spec.ts` additionally installs a live request listener and fails if
any harness page requests a non-loopback host. The "never touch the real site"
rule is enforced, not merely documented.

### 6.4 What the tests do not prove

Passing every suite does not demonstrate that JobPilot works on the real BOSS
Zhipin DOM. The fixtures are synthetic; the selectors are `fixture-only` or
`unverified`; `automationVerified` is `false`. Any claim to the contrary would be
false, and the type system is arranged so it cannot be written.

---

## 7. Extension points

**A new platform.** Implement `JobPlatform` in `src/adapters/<platform>/`, add it
to the composition root in `src/bootstrap/container.ts`, and list its id in
`config.general.enabledPlatforms`. Nothing in `domain/` or `application/` changes.
That is the point of Rule R2.

**A new rule.** Add a `Rule` in `src/domain/hard-filters.ts` or
`src/domain/scoring-rules.ts`, register it in `src/domain/rules-index.ts`, and add
its configuration field to `src/config/schema.ts`. Because scoring rules produce a
`RuleReason` with a `delta`, a new rule automatically appears in the explanation
the panel renders.

**A new effect.** Add the variant to the `Effect` union in
`src/application/events.ts`, return it from `reduce`, and handle it in
`Orchestrator.runEffect`. Both switches end in a `never` guard, so the compiler
lists every site that must change.

**A new selector.** Add it to `SELECTORS` in `src/adapters/boss/selectors.ts` with
an explicit `confidence` and a `note` explaining the ordering and what is unknown.
Never promote an entry out of `fixture-only`/`unverified` without evidence from
the real site.
