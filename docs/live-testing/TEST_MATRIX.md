# Live-testing matrix

The staged test matrix for verifying JobPilot against a live BOSS Zhipin session.

> **No live-site verification has occurred.** No row in this matrix has been
> executed against the real BOSS site. Every row is a **plan**, written against
> the behaviour specified in [`../product/boss-workflows.md`](../product/boss-workflows.md)
> and the design in [`../diagnostics/ARCHITECTURE.md`](../diagnostics/ARCHITECTURE.md).
> The selectors are `fixture-only` or `unverified`; the matrix exists to find out
> which ones survive contact with the real page.

**Every row must have all eleven fields.** The three rules in §Progression,
§Repetition and §Definition of ready are not advisory.

Read [`RUNBOOK.md`](./RUNBOOK.md) before executing any row. `Capability under
test` names what JobPilot claims; the row passes only if the claim holds *and*
nothing in the Forbidden column happens.

---

## Legend

**Risk** — the consequence if this behaviour is wrong:

| Risk | Meaning |
|---|---|
| `low` | cosmetic or observational; a wrong result is noticed immediately |
| `medium` | wrong classification or state; recoverable, no irreversible effect |
| `high` | could cause a wrong action; requires a bundle and a hard stop |
| `critical` | touches a send; a bug here sends into the wrong conversation, sends twice, or sends at all when it must not |

**Bundle** — `required` means the run is void without an exported bundle. Every
`high` and `critical` row is `required`; `low` rows may be observed and noted
without an export, but exporting is always preferred.

**Evidence** — the diagnostic artefacts that must be present in the bundle for
the run to count. Event names are the real `EVENTS` values from
`src/diagnostics/event.ts`.

**Status** — set to `NOT RUN` until executed. A row is `STABLE` only after the
repetition rule is satisfied.

---

# Stage 0 — Installation and observation

Nothing is automated. The purpose is to establish that JobPilot mounts, classifies
and observes without acting.

### T00 — Install the diagnostic build

| Field | Value |
|---|---|
| **Name** | Install the diagnostic build and confirm the channel |
| **Risk** | low |
| **Preconditions** | `pnpm build:diagnostic` succeeded; no other JobPilot script enabled |
| **Operator actions** | Paste `dist/jobpilot.diagnostic.user.js` into the userscript manager; save; reload a `zhipin.com` tab |
| **Expected** | The script installs; exactly one JobPilot script is enabled; the Diagnostics tab is present, which only the diagnostic channel shows |
| **Forbidden** | Any other JobPilot copy remaining enabled; a production build present; two JobPilot scripts running |
| **Evidence** | `manifest.json` shows `channel: "diagnostic"`, `bundleFormatVersion: 1`; `build.json` matches the recorded commit |
| **Pass** | Channel is `diagnostic`; commit matches the build you recorded; only one script enabled |
| **Bundle** | required |
| **Next allowed** | T01 |

### T01 — Bootstrap on BOSS

| Field | Value |
|---|---|
| **Name** | Bootstrap on a real BOSS page |
| **Risk** | medium |
| **Preconditions** | T00 passed; logged into BOSS by hand |
| **Operator actions** | Navigate to `https://www.zhipin.com/`; wait for the page to settle; open the panel |
| **Expected** | Bootstrap completes; the panel mounts in an open shadow root; page classification runs and exposes a page-kind value; no automation starts |
| **Forbidden** | Any click, navigation, typing or DOM mutation performed by JobPilot on the site's behalf; starting discovery or a session on its own |
| **Evidence** | `bootstrap` category events; `page.detected`; `page.fingerprinted`; `manifest.json` `sessionId: "pre-session"` if no session was started |
| **Pass** | Panel visible; a page kind is reported; zero site interactions attributable to JobPilot |
| **Bundle** | required |
| **Next allowed** | T02 |

### T02 — SPA navigation observation

| Field | Value |
|---|---|
| **Name** | Observe SPA route changes without acting |
| **Risk** | medium |
| **Preconditions** | T01 passed |
| **Operator actions** | Move between two BOSS pages using the site's own navigation, by hand, three times |
| **Expected** | Each route change is observed and recorded; page reclassification runs per route; the panel follows the route |
| **Forbidden** | JobPilot initiating navigation; duplicate `route.changed` per transition; the panel detaching or being mounted twice |
| **Evidence** | `route.changed` per transition with a `routeId`; `page.detected` after each; monotonic `sequence` ordering proves there is exactly one event per change |
| **Pass** | Three route changes produce three transitions, in order, none duplicated |
| **Bundle** | required |
| **Next allowed** | T03 |

### T03 — Panel mount and unmount

| Field | Value |
|---|---|
| **Name** | Panel mount and unmount across navigation |
| **Risk** | low |
| **Preconditions** | T02 passed |
| **Operator actions** | Navigate away from BOSS and back; observe the panel |
| **Expected** | The panel unmounts cleanly and mounts again once; no duplicate roots; no leaked listeners |
| **Forbidden** | Two panels; a panel left behind in the shadow root; an error on unmount |
| **Evidence** | No `error.uncaught` or `error.unhandled_rejection` during mount/unmount; observer events around each mount |
| **Pass** | Exactly one live panel at all times; no errors |
| **Bundle** | required |
| **Next allowed** | T04 |

### T04 — Page classification

| Field | Value |
|---|---|
| **Name** | Classify the real page kinds |
| **Risk** | medium |
| **Preconditions** | T03 passed |
| **Operator actions** | Visit, by hand, one page of each kind you intend to test: search results, a job detail, a chat page; note the page kind JobPilot reports for each |
| **Expected** | Each page is classified into the correct kind, or explicitly `unknown` |
| **Forbidden** | Guessing a kind for an unrecognised page — an unmatched page must be `unknown`, not a best guess |
| **Evidence** | `page.detected` with the kind and route pattern per page; `page.fingerprinted` |
| **Pass** | Classification correct for each page kind, and `unknown` where it genuinely is unknown. Record which kinds were misclassified — this is the first real signal about the selectors |
| **Bundle** | required |
| **Next allowed** | T05 |

### T05 — Passive risk and login detection

| Field | Value |
|---|---|
| **Name** | Detect risk and login states passively |
| **Risk** | high |
| **Preconditions** | T04 passed |
| **Operator actions** | Visit a CAPTCHA page, a security-verification page and a logged-out page, each by hand, in any order. **Do not attempt to solve anything** |
| **Expected** | Each is detected and recorded; JobPilot performs no action to resolve, dismiss or navigate around it |
| **Forbidden** | Any code path that dismisses, solves, retries through or navigates around a verification page |
| **Evidence** | `risk.captcha.detected`, `risk.security_verification.detected`, `risk.login.detected` as appropriate; an absence of any action event in the same window |
| **Pass** | Every risk page detected; **zero** actions taken in response |
| **Bundle** | required |
| **Next allowed** | Stage 1 |

---

# Stage 1 — Discovery on the real listing

Discovery only. No detail pages, no queue, no communication.

### T10 — Search-result detection

| Field | Value |
|---|---|
| **Name** | Detect a search-results listing |
| **Risk** | medium |
| **Preconditions** | Stage 0 complete; a search profile configured |
| **Operator actions** | Perform a search on BOSS by hand; run discovery; let it start from a search-results page |
| **Expected** | The listing is recognised; discovery starts; the resulting filter state is verified |
| **Forbidden** | Discovery starting on a page that is not a listing; enqueuing anything directly (Invariant P1) |
| **Evidence** | `selector.match` / `selector.miss` for the listing container; `page.detected`; no `queue.item.enqueued` |
| **Pass** | Listing recognised; discovery starts; nothing enqueued |
| **Bundle** | required |
| **Next allowed** | T11 |

### T11 — Job-card discovery

| Field | Value |
|---|---|
| **Name** | Discover the job cards in the listing |
| **Risk** | medium |
| **Preconditions** | T10 passed |
| **Operator actions** | Let discovery collect cards; do not scroll |
| **Expected** | The card container and per-card semantic groups are matched; a card count is reported |
| **Forbidden** | Partial card extraction silently treated as complete; a miss treated as an empty list |
| **Evidence** | `selector.match` with `matchedCount` and `visibleMatchCount` per candidate; `discovery` events; card count in `page.fingerprinted` |
| **Pass** | Cards discovered; count plausible against what is on screen; every miss recorded with its rejection reason |
| **Bundle** | required |
| **Next allowed** | T12 |

### T12 — Stable job ID extraction

| Field | Value |
|---|---|
| **Name** | Extract a stable job id from each card |
| **Risk** | high |
| **Preconditions** | T11 passed |
| **Operator actions** | Note the job ids JobPilot extracts; navigate into one job and back; return to the listing |
| **Expected** | The same job yields the same id before and after navigation; ids are unique across cards |
| **Forbidden** | An id derived from a list position or a DOM index (which changes with scrolling); two different jobs sharing an id |
| **Evidence** | `jobId` on discovery events, comparable across the two passes; `selector.match` for the id source |
| **Pass** | Ids stable across a round trip and unique within the listing |
| **Bundle** | required |
| **Next allowed** | T13 |

### T13 — Duplicate job handling

| Field | Value |
|---|---|
| **Name** | Re-discovering the same job does not duplicate it |
| **Risk** | high |
| **Preconditions** | T12 passed |
| **Operator actions** | Run discovery twice on the same listing without changing anything |
| **Expected** | The second run recognises the same jobs; no duplicate candidates |
| **Forbidden** | A second entry for a job already known; a silent dedup that drops a genuinely new job |
| **Evidence** | `queue.item.duplicate` on the repeat; candidate counts from both runs |
| **Pass** | No duplicates; the second run's count matches the first |
| **Bundle** | required |
| **Next allowed** | T14 |

### T14 — Incremental scrolling

| Field | Value |
|---|---|
| **Name** | Discover incrementally as the list scrolls |
| **Risk** | medium |
| **Preconditions** | T13 passed |
| **Operator actions** | Scroll the listing slowly by hand, pausing between screens |
| **Expected** | New cards are collected incrementally and debounced; already-seen cards are not recounted |
| **Forbidden** | Re-collecting the whole list on every scroll; a burst of duplicate discovery events |
| **Evidence** | `discovery` events over time; `selector.match` counts per batch; no `diagnostics.buffer.truncated` |
| **Pass** | Monotonic growth in distinct jobs; no duplication; no buffer truncation |
| **Bundle** | required |
| **Next allowed** | T15 |

### T15 — Changed-list DOM

| Field | Value |
|---|---|
| **Name** | Cope with the listing DOM changing mid-discovery |
| **Risk** | high |
| **Preconditions** | T14 passed |
| **Operator actions** | While discovery is running, trigger a list re-render by hand — apply a sort order or change a filter |
| **Expected** | The change is observed; JobPilot pauses or restarts discovery cleanly; no partial state is treated as complete |
| **Forbidden** | Continuing with stale card references; reporting success on a list that was replaced underneath it |
| **Evidence** | `selector.miss` or `selector.ambiguous` at the change point; `page.detected` re-run; the pause/restart in `state.transition` |
| **Pass** | The change is detected and handled without a false success |
| **Bundle** | required |
| **Next allowed** | T16 |

### T16 — User changes filters

| Field | Value |
|---|---|
| **Name** | User changes search filters during discovery |
| **Risk** | medium |
| **Preconditions** | T15 passed |
| **Operator actions** | While discovery is running, change a search filter by hand |
| **Expected** | Discovery pauses; a restart is required; no results from the old filter are mixed with the new |
| **Forbidden** | Silently merging results across two different filter states |
| **Evidence** | `user.changed_route` or a filter-change event; the resulting pause transition |
| **Pass** | Discovery pauses and requires an explicit restart; the collected set is attributable to one filter state |
| **Bundle** | required |
| **Next allowed** | Stage 2 |

---

# Stage 2 — Detail parsing

Open single jobs and read them. No queue, no communication.

### T20 — Open a single job

| Field | Value |
|---|---|
| **Name** | Open one job's detail view |
| **Risk** | medium |
| **Preconditions** | Stage 1 complete |
| **Operator actions** | Select one job from the listing by hand; let JobPilot open its detail |
| **Expected** | The detail view opens; `effect.open_job.started` / `effect.completed` are recorded; the detail root is identified |
| **Forbidden** | Opening more than one job; acting before the detail is confirmed to belong to the intended job id |
| **Evidence** | `effect.started` / `effect.completed` for `open_job` (the ARCHITECTURE §5 example form is `effect.open_job.started`); the job id on the effect events |
| **Pass** | Exactly one job opened; the recorded job id matches the job you selected |
| **Bundle** | required |
| **Next allowed** | T21 |

### T21 — Detail ready detection

| Field | Value |
|---|---|
| **Name** | Detect when the detail is actually ready |
| **Risk** | high |
| **Preconditions** | T20 passed |
| **Operator actions** | Open a job and observe the interval between opening and "detail ready" |
| **Expected** | Readiness is determined from a structural condition belonging to the correct job id, not from a fixed delay |
| **Forbidden** | Parsing a skeleton or a previous job's detail; declaring ready on a timer alone |
| **Evidence** | `effect.completed` duration for `open_job`; the readiness condition's selector outcome; `monotonicTime` deltas |
| **Pass** | Ready is declared only when the detail belongs to the intended job; a timeout is `FAILED(DETAIL_TIMEOUT)`, never a silent continue |
| **Bundle** | required |
| **Next allowed** | T22 |

### T22 — Title and company parsing

| Field | Value |
|---|---|
| **Name** | Parse the job title and company |
| **Risk** | high |
| **Preconditions** | T21 passed |
| **Operator actions** | Open three jobs with visibly different titles and companies |
| **Expected** | Title and company are extracted correctly for each |
| **Forbidden** | Falling back to card text when the detail parse misses; returning a plausible-looking wrong string |
| **Evidence** | `parser` events with the parsed values; `selector.match` per field with its confidence |
| **Pass** | All three correct. Record any miss as a selector finding with its confidence |
| **Bundle** | required |
| **Next allowed** | T23 |

### T23 — Salary parsing

| Field | Value |
|---|---|
| **Name** | Parse the salary field |
| **Risk** | medium |
| **Preconditions** | T22 passed |
| **Operator actions** | Open jobs with different salary shapes — a range, a single value, "negotiable", and one absent |
| **Expected** | Each shape parses correctly; an absent salary is absent, not zero |
| **Forbidden** | Defaulting an unparseable salary to a number; treating "negotiable" as a value |
| **Evidence** | `parser` events with the raw and parsed forms; `selector.miss` where the field is genuinely absent |
| **Pass** | All four shapes handled correctly and distinctly |
| **Bundle** | required |
| **Next allowed** | T24 |

### T24 — Location parsing

| Field | Value |
|---|---|
| **Name** | Parse the location |
| **Risk** | medium |
| **Preconditions** | T23 passed |
| **Operator actions** | Open jobs in different cities and districts |
| **Expected** | Location parses to the city and district actually shown |
| **Forbidden** | Substituting the search profile's city when the detail says otherwise |
| **Evidence** | `parser` events with the parsed location |
| **Pass** | Correct for each job; disagreement with the profile's city recorded, not masked |
| **Bundle** | required |
| **Next allowed** | T25 |

### T25 — Recruiter parsing

| Field | Value |
|---|---|
| **Name** | Parse the recruiter identity |
| **Risk** | medium |
| **Preconditions** | T24 passed |
| **Operator actions** | Open jobs from different recruiters, including one with a minimal profile |
| **Expected** | Recruiter name and role parse; a missing field is `unknown`, not a guess |
| **Forbidden** | Fabricating a recruiter value from nearby text |
| **Evidence** | `parser` events; `selector.miss` where fields are absent |
| **Pass** | Correct where present; explicitly `unknown` where absent |
| **Bundle** | required |
| **Next allowed** | T26 |

### T26 — Recruiter activity parsing

| Field | Value |
|---|---|
| **Name** | Parse recruiter activity |
| **Risk** | medium |
| **Preconditions** | T25 passed |
| **Operator actions** | Open several jobs; note the activity label each shows |
| **Expected** | Activity parses where the label is unambiguous; contradictory labels resolve to the least-active state |
| **Forbidden** | Optimistic resolution of contradictory labels |
| **Evidence** | `parser` events with the label and the resolution |
| **Pass** | Unambiguous labels correct; contradictory labels resolve conservatively. `unknown` is a legitimate and expected outcome — `README.md` §Known limitations 8 records that it is common |
| **Bundle** | required |
| **Next allowed** | T27 |

### T27 — Already-contacted detection

| Field | Value |
|---|---|
| **Name** | Detect a job already contacted |
| **Risk** | critical |
| **Preconditions** | T26 passed; at least one job you have already contacted |
| **Operator actions** | Open a job you have already messaged; observe |
| **Expected** | The platform's own state is treated as contacted; the item is skipped, labelled `already contacted (assumed)` where ambiguous |
| **Forbidden** | Offering to contact an already-contacted job; treating an ambiguous indicator as "not contacted" and proceeding |
| **Evidence** | `parser` events for the platform state; `queue.item.skipped` or a blocked outcome; `filter` events |
| **Pass** | Correctly identified as contacted. Policy is **prefer a false skip over a duplicate send** — if it wrongly skips, that is a finding, but it is the safe direction |
| **Bundle** | required |
| **Next allowed** | T28 |

### T28 — Unsupported detail layout

| Field | Value |
|---|---|
| **Name** | Fail closed on an unsupported detail layout |
| **Risk** | high |
| **Preconditions** | T27 passed; find a job detail whose structure differs from the others |
| **Operator actions** | Open a detail page with an unusual layout — a different page kind, an embedded or iframed detail, or a job from a different BOSS surface |
| **Expected** | The layout is unsupported; JobPilot fails closed rather than parsing partially |
| **Forbidden** | Returning partial data as if complete; falling back to card data; a text-based heuristic to "find" the fields |
| **Evidence** | `selector.miss` with the rejection reason; an explicit unsupported/failed classification |
| **Pass** | Fails closed, with the reason recorded. This is the fail-closed guarantee — an unrecognised page is `unknown`, not a guess |
| **Bundle** | required |
| **Next allowed** | Stage 3 |

---

# Stage 3 — Queue behaviour

The queue and its lifecycle, with no communication.

### T30 — Hard-filter rejection

| Field | Value |
|---|---|
| **Name** | A hard-filtered job is rejected at Stage A |
| **Risk** | medium |
| **Preconditions** | Stage 2 complete; a profile whose filters reject a known job |
| **Operator actions** | Run discovery over a listing containing a job your filters must reject |
| **Expected** | The job is rejected on card data alone; no detail page is opened for it |
| **Forbidden** | Opening a detail page for a job rejectable from the card |
| **Evidence** | `filter` events with the rule and the trace; no `effect.open_job.started` for that job id |
| **Pass** | Rejected at Stage A; the rule trace names the rule that rejected it (Invariant: no score without reasons) |
| **Bundle** | required |
| **Next allowed** | T31 |

### T31 — Accepted job

| Field | Value |
|---|---|
| **Name** | An accepted job reaches the review surface |
| **Risk** | medium |
| **Preconditions** | T30 passed |
| **Operator actions** | Run discovery over a listing containing a job your rules accept |
| **Expected** | The job survives Stage A, is opened for Stage B, is scored, and appears in Matches with its trace |
| **Forbidden** | Enqueuing directly from discovery (Invariant P1: discovery never enqueues; the user always passes through Matches) |
| **Evidence** | `scoring` events with the rule trace; the job present in the Matches view; no `queue.item.enqueued` |
| **Pass** | Scored, explained, visible in Matches, **not** enqueued |
| **Bundle** | required |
| **Next allowed** | T32 |

### T32 — Scoring explanation

| Field | Value |
|---|---|
| **Name** | Every score carries an ordered rule trace |
| **Risk** | medium |
| **Preconditions** | T31 passed |
| **Operator actions** | Inspect the score and reasons for three accepted and three rejected jobs |
| **Expected** | Each carries an ordered trace naming the rules that fired, with the resulting score |
| **Forbidden** | A score with no trace; a trace that does not sum to the score |
| **Evidence** | `scoring` events containing the full trace; the rendered reasons in the panel |
| **Pass** | All six have complete, ordered, arithmetically consistent traces |
| **Bundle** | required |
| **Next allowed** | T33 |

### T33 — Add one job to the queue

| Field | Value |
|---|---|
| **Name** | Add exactly one job to the queue |
| **Risk** | medium |
| **Preconditions** | T32 passed |
| **Operator actions** | Select exactly one job in Matches and add it to the queue |
| **Expected** | Exactly one queue item is created; nothing is executed |
| **Forbidden** | Any job being opened or communicated as a side effect of enqueuing |
| **Evidence** | `queue.item.enqueued` with the job id; the Queue tab showing one item; no `effect.open_job` |
| **Pass** | One item, correct job id, no side effects |
| **Bundle** | required |
| **Next allowed** | T34 |

### T34 — Queue pause

| Field | Value |
|---|---|
| **Name** | Pause the queue |
| **Risk** | medium |
| **Preconditions** | T33 passed |
| **Operator actions** | Start the queue, then pause it |
| **Expected** | Execution stops promptly; the current item's state is preserved; the pause is recorded |
| **Forbidden** | An in-flight irreversible action being abandoned mid-way, or continuing after the pause |
| **Evidence** | `user.pause`; the pause `state.transition`; no action events after it |
| **Pass** | Execution stops; no action event follows the pause in `sequence` order |
| **Bundle** | required |
| **Next allowed** | T35 |

### T35 — Queue resume

| Field | Value |
|---|---|
| **Name** | Resume the queue |
| **Risk** | medium |
| **Preconditions** | T34 passed |
| **Operator actions** | Resume from the paused state |
| **Expected** | Execution resumes from where it paused; queue progress was not discarded (Invariant M2) |
| **Forbidden** | Replaying a completed item; losing queue progress on resume |
| **Evidence** | `user.resume`; the resume transition; the queue snapshot showing the same items |
| **Pass** | Resumes without replay and without loss |
| **Bundle** | required |
| **Next allowed** | T36 |

### T36 — Skip a queue item

| Field | Value |
|---|---|
| **Name** | Skip the current queue item |
| **Risk** | medium |
| **Preconditions** | T35 passed; at least two items queued |
| **Operator actions** | Skip the item currently being processed |
| **Expected** | The item is marked skipped; the next item is taken cleanly |
| **Forbidden** | Skipping leaving an armed intent behind; the skipped job being reprocessed |
| **Evidence** | `user.skip`; `queue.item.skipped` with the job id; the next `queue.item.started` |
| **Pass** | Skipped and moved on; no orphaned intent |
| **Bundle** | required |
| **Next allowed** | T37 |

### T37 — Page refresh with a queued job

| Field | Value |
|---|---|
| **Name** | Refresh the page while a job is queued |
| **Risk** | high |
| **Preconditions** | T36 passed; at least one job queued |
| **Operator actions** | Refresh the page with a job queued but not started |
| **Expected** | Queue state is restored from persistence; the item is still queued; nothing is replayed |
| **Forbidden** | Losing the queue; duplicating the item; executing anything on load without an explicit user action |
| **Evidence** | `storage.read` on boot; the restored queue snapshot; no action events between load and your first explicit command |
| **Pass** | Queue restored exactly; nothing executed automatically |
| **Bundle** | required |
| **Next allowed** | T38 |

### T38 — Route change while queued

| Field | Value |
|---|---|
| **Name** | Navigate away while a job is queued |
| **Risk** | high |
| **Preconditions** | T37 passed |
| **Operator actions** | Navigate to a different BOSS page with a job queued |
| **Expected** | The queue survives; JobPilot pauses or reclassifies the page; the item is not processed on an unrelated page |
| **Forbidden** | Processing a queued job while the current page is not the job's detail; losing the queue on navigation |
| **Evidence** | `user.changed_route` / `route.changed`; the resulting pause or reclassification; the queue snapshot intact |
| **Pass** | Queue intact; nothing processed on the wrong page |
| **Bundle** | required |
| **Next allowed** | Stage 4 |

---

# Stage 4 — Assist mode, stopping before send

**Assist mode. Stop before send wherever the row allows it.** These rows exercise
the communication transaction's early phases without reaching the send. Where a
row *must* cross an irreversible boundary, it says so explicitly.

### T40 — Identify the communicate action

| Field | Value |
|---|---|
| **Name** | Identify the communicate affordance on a real detail page |
| **Risk** | high |
| **Preconditions** | Stage 3 complete; Assist mode |
| **Operator actions** | Open a job with an actionable communicate control; let JobPilot locate the affordance |
| **Expected** | The affordance is found inside the active detail root and its text classifies as communicate |
| **Forbidden** | Matching an affordance outside the active detail root; classifying an unrelated button as communicate |
| **Evidence** | `communication.action.discovered`; `selector.match` for the action with its confidence |
| **Pass** | Correctly identified. If it is misidentified, stop — this is the input to everything that follows |
| **Bundle** | required |
| **Next allowed** | T41 |

### T41 — Intent creation

| Field | Value |
|---|---|
| **Name** | Create and persist a communication intent |
| **Risk** | critical |
| **Preconditions** | T40 passed |
| **Operator actions** | Arm a communication for the selected job |
| **Expected** | An intent is created with a stable transaction id and persisted as `armed`; no click occurs yet |
| **Forbidden** | Creating a second intent for the same job (must be `FAILED(DUPLICATE_INTENT)`); arming without persisting |
| **Evidence** | `communication.intent.created`, `communication.intent.armed`, `communication.preconditions.checked`; the transaction in `transactions.json` with phase `armed` |
| **Pass** | One intent, persisted, phase `armed`, no click |
| **Bundle** | required |
| **Next allowed** | T42 |

### T42 — Success modal detection

| Field | Value |
|---|---|
| **Name** | Classify the success modal |
| **Risk** | critical |
| **Preconditions** | T41 passed |
| **Operator actions** | Click communicate (this crosses into the transaction); observe the modal |
| **Expected** | A known success modal is classified as such; an unrecognised dialog is `UNKNOWN_MODAL` and blocking |
| **Forbidden** | Treating an unrecognised dialog as success; continuing through an unknown modal |
| **Evidence** | `communication.modal.observed` with the classification; `risk.unknown_modal.detected` if unknown; the resulting `state.transition` to blocked |
| **Pass** | Known modal classified correctly; **an unknown modal must block** (Invariant: no continuation through an unknown blocking modal) |
| **Bundle** | required |
| **Next allowed** | T43 |

### T43 — Chat route detection

| Field | Value |
|---|---|
| **Name** | Detect arrival at the chat route |
| **Risk** | critical |
| **Preconditions** | T42 passed |
| **Operator actions** | Let the transaction proceed from the modal to the chat |
| **Expected** | The SPA route change to the conversation is observed and recorded |
| **Forbidden** | Assuming arrival without observing it; a navigation timeout treated as success |
| **Evidence** | `communication.navigation.started`; `route.changed`; `communication.modal.observed` preceding it |
| **Pass** | Arrival observed, in order, with the transaction id carried through |
| **Bundle** | required |
| **Next allowed** | T44 |

### T44 — Chat identity verification

| Field | Value |
|---|---|
| **Name** | Verify the conversation belongs to the job |
| **Risk** | critical |
| **Preconditions** | T43 passed |
| **Operator actions** | Let identity evaluation run on the real conversation |
| **Expected** | Identity is confirmed by a job-id match, or by title plus company/recruiter; the conversation is stable for `chatStableMs` |
| **Forbidden** | A bare editor authorising a send; `insufficient` evidence treated as a match; proceeding on contradictory evidence |
| **Evidence** | `chat.candidate.detected`, `chat.identity.evaluated`, `chat.identity.matched`; the evidence used recorded in `transactions.json` |
| **Pass** | Verified with the evidence recorded. **A bare editor is never sufficient** |
| **Bundle** | required |
| **Next allowed** | T45. **If T44 fails, T60 must not run** |

### T45 — Wrong chat rejection

| Field | Value |
|---|---|
| **Name** | Reject the wrong conversation |
| **Risk** | critical |
| **Preconditions** | T44 passed |
| **Operator actions** | By hand, manoeuvre the page so the chat shown belongs to a different job than the intent expects — e.g. open a conversation for another job while an intent is armed |
| **Expected** | The mismatch is detected and rejected; the transaction aborts |
| **Forbidden** | Sending into the wrong conversation under any circumstance. This is a **privacy failure, not a bug** |
| **Evidence** | `chat.identity.rejected` with the reason; the transaction ending `failed`, or `uncertain` if a send was already attempted |
| **Pass** | Rejected, with the reason recorded. Nothing is typed and nothing is sent |
| **Bundle** | required |
| **Next allowed** | T46 |

### T46 — Existing draft protection

| Field | Value |
|---|---|
| **Name** | Never overwrite a user draft |
| **Risk** | critical |
| **Preconditions** | T45 passed |
| **Operator actions** | Type text into the conversation editor by hand, then let the transaction reach the draft check |
| **Expected** | The draft is reported and left untouched; the item is `BLOCKED(DRAFT_PRESENT)` |
| **Forbidden** | Overwriting, clearing or sending over user-typed content. User content always wins |
| **Evidence** | `message.draft.checked` with the outcome; the block transition with reason `draft-present`; a `gate.blocked` event |
| **Pass** | Draft detected, untouched, transaction blocked. The check runs before claiming the item, before inserting and before the click |
| **Bundle** | required |
| **Next allowed** | T47 |

### T47 — Template preparation

| Field | Value |
|---|---|
| **Name** | Prepare the message from a template |
| **Risk** | high |
| **Preconditions** | T46 passed; a template configured |
| **Operator actions** | Let the transaction prepare a message into an empty editor |
| **Expected** | The message is composed from the template with the variables substituted; the editor content is re-verified against what was inserted |
| **Forbidden** | Sending at this point unless the row explicitly says so; recording the message text in diagnostics |
| **Evidence** | `message.source.selected`, `message.editor.inspected`, `message.prepared`; the recorded `templateId`, `messageLength`, digest and **variable names** — never the text |
| **Pass** | Composed and re-verified; the editor matches the intended text; diagnostics contain no message body |
| **Bundle** | required |
| **Next allowed** | T48 |

### T48 — User switches chat during preparation

| Field | Value |
|---|---|
| **Name** | User switches conversation while a message is prepared |
| **Risk** | critical |
| **Preconditions** | T47 passed |
| **Operator actions** | Immediately after preparation, switch to a different conversation by hand |
| **Expected** | The change is detected; the transaction aborts — `uncertain` if a send was already attempted, otherwise `failed`; the user's content is never modified (Invariant C1) |
| **Forbidden** | Sending after the conversation changed; modifying or clearing anything the user typed |
| **Evidence** | `chat.identity.rejected` or a route-change event; the resulting transaction status |
| **Pass** | Aborted in the correct direction, with the user's content intact |
| **Bundle** | required |
| **Next allowed** | Stage 5 |

---

# Stage 5 — Blocking and risk states

Every row here expects JobPilot to **stop**. A row fails if JobPilot does
anything other than stop and record.

### T50 — Login required

| Field | Value |
|---|---|
| **Name** | Blocked by a login-required state |
| **Risk** | high |
| **Preconditions** | Stage 4 complete |
| **Operator actions** | Log out by hand, or otherwise induce the login-required state, with an intent armed or the queue running |
| **Expected** | `BLOCKED_HUMAN_VERIFICATION` is entered; actions stop immediately; pending safe effects are cancelled; the persisted transaction evidence is **not** cancelled; the panel shrinks out of the way |
| **Forbidden** | Any JobPilot action to resolve the state; cancelling persisted communication evidence |
| **Evidence** | `risk.login.detected`; the block `state.transition`; the transaction still present in `transactions.json` |
| **Pass** | Blocked, stopped, evidence preserved |
| **Bundle** | required |
| **Next allowed** | T51 |

### T51 — CAPTCHA / security verification

| Field | Value |
|---|---|
| **Name** | Blocked by CAPTCHA or security verification |
| **Risk** | high |
| **Preconditions** | T50 passed |
| **Operator actions** | Induce a CAPTCHA or security-verification page with the queue running |
| **Expected** | Same as T50: immediate stop, block, evidence preserved, panel out of the way. Recovery is strictly two-step and never automatic |
| **Forbidden** | Dismissing, solving, retrying through or navigating around the verification; touching verification widgets; resuming because the challenge merely disappeared |
| **Evidence** | `risk.captcha.detected` / `risk.security_verification.detected`; `risk.human_verification.recheck` and `risk.human_verification.resolved` if you complete the recovery; a `gate.blocked` with reason `human-verification` |
| **Pass** | Blocked with zero widget interaction. Then complete the challenge by hand, press **Re-check page**, confirm the validation runs (login valid, risk UI gone, route sane, transaction state safe, persistence healthy, queue ownership valid), see **Ready to resume**, and press **Resume** explicitly |
| **Bundle** | required |
| **Next allowed** | T52 |

### T52 — Operation-too-frequent warning

| Field | Value |
|---|---|
| **Name** | Blocked by an operation-too-frequent warning |
| **Risk** | high |
| **Preconditions** | T51 passed |
| **Operator actions** | Induce BOSS's too-frequent warning |
| **Expected** | Detected and blocking; actions stop; the reason is surfaced in plain language as the largest text on screen |
| **Forbidden** | Retrying through the warning; continuing automation |
| **Evidence** | `risk.too_frequent.detected`; the block transition; a `gate.blocked` with reason `rate-limited` if a subsequent arm is attempted |
| **Pass** | Blocked, stopped, explained |
| **Bundle** | required |
| **Next allowed** | T53 |

### T53 — Unknown blocking modal

| Field | Value |
|---|---|
| **Name** | Blocked by an unrecognised modal |
| **Risk** | critical |
| **Preconditions** | T52 passed |
| **Operator actions** | Cause a modal JobPilot does not recognise to appear — an incidental site dialog, a survey, an announcement |
| **Expected** | Classified as unknown; treated as blocking; JobPilot fails closed and records it |
| **Forbidden** | Dismissing it; continuing through it; treating it as a success modal. **No continuation through an unknown blocking modal** |
| **Evidence** | `risk.unknown_modal.detected`; `communication.modal.observed` with the unknown classification if inside a transaction; the block transition |
| **Pass** | Blocked with zero interaction with the dialog |
| **Bundle** | required |
| **Next allowed** | Stage 6, only if every Stage 0–5 row passed twice |

---

# Stage 6 — First real communication

> **The first irreversible test.** Exactly one explicitly selected job. All of
> Stage 0 through Stage 5 must have passed twice, and the "Definition of ready"
> checklist in this document must be complete.

### T60 — One real communication

| Field | Value |
|---|---|
| **Name** | Send one first message to exactly one explicitly selected job |
| **Risk** | critical |
| **Preconditions** | Every row in Stages 0–5 passed **twice**; the "Definition of ready" checklist below is complete; exactly **one** job selected, by hand, explicitly |
| **Operator actions** | Select one job and one job only; run the transaction to completion with the operator present throughout |
| **Expected** | The full ordered trace runs: intent created → armed → action discovered → preconditions checked → navigation → modal observed → chat candidate detected → identity evaluated → matched → message source selected → editor inspected → draft check completed → message prepared → **send attempt persisted** → clicked → verification started → outgoing message found → transaction committed |
| **Forbidden** | A second send; any send to a job other than the selected one; clicking send without a persisted intent; a committed transaction without an observed outgoing-message delta |
| **Evidence** | The complete trace above, in `sequence` order, in `transactions.json`; `communication.send.attempt.persisted` **preceding** `communication.send.clicked`; `communication.outgoing.found`; `communication.transaction.committed` |
| **Pass** | Exactly one message sent, to exactly the selected job, with the persisted-intent-before-click ordering visible in the bundle. Success is only ever reported from an observed outgoing-message delta — **a clicked button is not evidence** |
| **Bundle** | required |
| **Next allowed** | Stage 7 |

---

# Stage 7 — Interruption and recovery

Interruptions around the send boundary. These are the rows that catch a duplicate
send, so they are all `critical` or `high`.

### T70 — Refresh before the send attempt

| Field | Value |
|---|---|
| **Name** | Refresh before a send attempt |
| **Risk** | high |
| **Preconditions** | Stage 6 complete |
| **Operator actions** | Arm an intent, then refresh the page **before** the send attempt is persisted |
| **Expected** | On boot, the live intent is found; it is not `send-attempted`, so it is abandoned safely — nothing was sent — and normal operation resumes |
| **Forbidden** | Replaying the abandoned intent automatically; treating it as `uncertain` when no send was attempted |
| **Evidence** | `storage.read` on boot; the intent phase at the time of the refresh; the safe-abandon path in `state.transition` |
| **Pass** | Abandoned safely; nothing sent; recovery explicit |
| **Bundle** | required |
| **Next allowed** | T71 |

### T71 — Refresh after the intent is created

| Field | Value |
|---|---|
| **Name** | Refresh after the intent reaches `send-attempted` |
| **Risk** | critical |
| **Preconditions** | T70 passed |
| **Operator actions** | Drive a transaction to `send-attempted`, then refresh before the outcome is observed |
| **Expected** | On boot the recovered `send-attempted` transaction is resolved **by verification only**: re-locate the conversation, count outgoing messages against the recorded baseline. Count increased → `verified`; count equal → `uncertain`, never `failed` |
| **Forbidden** | Clicking send again under any path. **Once an intent reaches `send-attempted`, no reload, timeout, retry or recovery path may click send again** |
| **Evidence** | `communication.send.attempt.persisted` before the refresh; the recovery path on boot; the resolved status in `transactions.json`; `communication.transaction.uncertain` where applicable |
| **Pass** | Resolved by verification; exactly one message exists; no second click in the bundle |
| **Bundle** | required |
| **Next allowed** | T72 |

### T72 — Navigation after chat verified

| Field | Value |
|---|---|
| **Name** | Navigate away after the chat is verified |
| **Risk** | critical |
| **Preconditions** | T71 passed |
| **Operator actions** | Verify a chat, then navigate to another BOSS page by hand before the message is prepared |
| **Expected** | The route change is observed; the transaction aborts; nothing is sent |
| **Forbidden** | Sending after leaving the conversation; resuming the transaction on the new page |
| **Evidence** | `route.changed` after `chat.identity.matched`; the transaction ending `failed` (no send attempted) |
| **Pass** | Aborted; nothing sent |
| **Bundle** | required |
| **Next allowed** | T73 |

### T73 — User enters a draft before send

| Field | Value |
|---|---|
| **Name** | User types into the editor before the send |
| **Risk** | critical |
| **Preconditions** | T72 passed |
| **Operator actions** | Let a message be prepared, then type into the editor yourself before the click |
| **Expected** | The change since insertion is detected; the item is `BLOCKED(USER_INTERRUPTED)`; the user's content is never modified |
| **Forbidden** | Sending text that differs from what was prepared; overwriting the user's text |
| **Evidence** | `message.draft.checked` with the outcome; `message.editor.inspected` showing the mismatch; the block transition |
| **Pass** | Blocked; user content intact; nothing sent |
| **Bundle** | required |
| **Next allowed** | T74 |

### T74 — User switches conversation

| Field | Value |
|---|---|
| **Name** | User switches conversation before the send |
| **Risk** | critical |
| **Preconditions** | T73 passed |
| **Operator actions** | With a message prepared, switch to a different conversation by hand |
| **Expected** | The switch is detected; the transaction aborts; `uncertain` if a send was attempted, otherwise `failed` (Invariant C1) |
| **Forbidden** | Sending into the newly opened conversation; modifying the user's content |
| **Evidence** | `chat.identity.rejected` or the route change; the resulting transaction status |
| **Pass** | Aborted in the correct direction |
| **Bundle** | required |
| **Next allowed** | T75 |

### T75 — Page changes before the send

| Field | Value |
|---|---|
| **Name** | The page changes underneath a prepared transaction |
| **Risk** | critical |
| **Preconditions** | T74 passed |
| **Operator actions** | With a message prepared, cause the page to change — a background re-render, an in-page notification, a partial reload |
| **Expected** | The change is detected; the editor is re-verified; the transaction does not proceed on stale references |
| **Forbidden** | Clicking send against an element that no longer corresponds to the prepared state |
| **Evidence** | `message.editor.inspected` before the click with a changed fingerprint; the selector outcomes; the resulting abort |
| **Pass** | Detected and aborted; nothing sent on stale state |
| **Bundle** | required |
| **Next allowed** | T76 |

### T76 — Verification cannot determine the send outcome

| Field | Value |
|---|---|
| **Name** | An unobservable send outcome |
| **Risk** | critical |
| **Preconditions** | T75 passed |
| **Operator actions** | Drive a transaction to `send-attempted` and make the outcome unobservable — close the page before the outgoing delta is visible, or interrupt the observation window |
| **Expected** | The transaction is `uncertain`. It is **never** rounded to success and never auto-retried; it requires human resolution, and is surfaced as a first-class state with its own badge |
| **Forbidden** | Reporting `verified` without an observed outgoing delta; retrying automatically; rounding `uncertain` to `failed` or to success |
| **Evidence** | `communication.send.attempt.persisted`; `communication.transaction.uncertain`; the absence of `communication.outgoing.found` |
| **Pass** | `uncertain`, correctly, and surfaced to the user for resolution |
| **Bundle** | required |
| **Next allowed** | Stage 8 |

---

# Stage 8 — Multi-tab ownership

Two real browser tabs. This is the first row set that exercises
`navigator.locks` against actual tabs rather than a fake `LockManager`.

### T80 — Two tabs open

| Field | Value |
|---|---|
| **Name** | Two tabs with JobPilot running |
| **Risk** | high |
| **Preconditions** | Stage 7 complete |
| **Operator actions** | Open a second BOSS tab with JobPilot enabled; observe both panels |
| **Expected** | The lock is requested by both; one acquires; the other is rejected with a reason; the non-owner renders the panel in **read-only** mode so the user is never left wondering whether JobPilot is running |
| **Forbidden** | Both tabs acting; the non-owner starting discovery or the queue |
| **Evidence** | `lock.requested` twice; `lock.acquired` once; `lock.rejected` once with `holder`; the UI showing the execution owner |
| **Pass** | Exactly one owner; the other read-only and told why |
| **Bundle** | required |
| **Next allowed** | T81 |

### T81 — First tab acquires ownership

| Field | Value |
|---|---|
| **Name** | The first tab owns execution |
| **Risk** | high |
| **Preconditions** | T80 passed |
| **Operator actions** | Start the queue in the owning tab |
| **Expected** | The owner executes; the lease is renewed on a heartbeat |
| **Forbidden** | The non-owner executing; the lease silently lapsing while the owner is alive |
| **Evidence** | `lock.renewed` on a periodic cadence; execution events only from the owning tab id |
| **Pass** | Execution strictly in the owner; renewals present |
| **Bundle** | required |
| **Next allowed** | T82 |

### T82 — Second tab attempts execution

| Field | Value |
|---|---|
| **Name** | The second tab attempts to execute |
| **Risk** | critical |
| **Preconditions** | T81 passed |
| **Operator actions** | In the non-owning tab, press Start / Discover |
| **Expected** | Refused with a plain explanation; no execution begins; a `not-owner` gate refusal is recorded |
| **Forbidden** | Any execution in the second tab. **No second tab executing the same queue** |
| **Evidence** | `lock.rejected`; a `gate.blocked` with reason `not-owner`; no execution events from the second tab id |
| **Pass** | Refused, explained, recorded |
| **Bundle** | required |
| **Next allowed** | T83 |

### T83 — Owner tab closes

| Field | Value |
|---|---|
| **Name** | The owning tab closes mid-queue |
| **Risk** | critical |
| **Preconditions** | T82 passed; a job in flight |
| **Operator actions** | Close the owning tab while it holds the lease |
| **Expected** | The lease expires; the remaining tab is not yet executing |
| **Forbidden** | The lease being renewed by a dead tab; the surviving tab executing without re-acquiring |
| **Evidence** | `lock.lease.expired`; the absence of further `lock.renewed` from the closed tab's id |
| **Pass** | Lease expires; no phantom renewals |
| **Bundle** | required |
| **Next allowed** | T84 |

### T84 — Lease recovery

| Field | Value |
|---|---|
| **Name** | Lease recovery and takeover |
| **Risk** | critical |
| **Preconditions** | T83 passed |
| **Operator actions** | In the surviving tab, attempt to acquire ownership |
| **Expected** | The stale lease is reclaimable; the surviving tab acquires it; on takeover it **re-reads the live intent and applies the recovery rules** |
| **Forbidden** | Replaying an ambiguous send on takeover. A takeover **never** replays an irreversible action |
| **Evidence** | `lock.acquired` in the surviving tab; the intent re-read and its resolution; no duplicate send in `transactions.json` |
| **Pass** | Ownership recovered; any live intent resolved by verification, not by replaying |
| **Bundle** | required |
| **Next allowed** | T85 |

### T85 — Ownership transfer

| Field | Value |
|---|---|
| **Name** | Ownership transfers cleanly |
| **Risk** | high |
| **Preconditions** | T84 passed |
| **Operator actions** | Release ownership and re-acquire it, in either tab |
| **Expected** | The full `requested / acquired / renewed / released / ownership_changed` sequence is recorded with `tabId`, `ownerId` and `leaseId`, so ownership at any point in time is reconstructable |
| **Forbidden** | Two tabs believing they own execution simultaneously; a gap in the ownership record |
| **Evidence** | `lock.released`, `lock.ownership.changed` with the holder; `transactions.json` and `events.ndjson` agreeing on the sequence |
| **Pass** | Ownership at every moment is unambiguous from the bundle |
| **Bundle** | required |
| **Next allowed** | Stage 9 |

---

# Stage 9 — Storage health

Persistence failure must never be silent. Every row here expects JobPilot to
**degrade visibly and refuse to act**, not to continue.

### T90 — Storage read failure

| Field | Value |
|---|---|
| **Name** | Storage read failure |
| **Risk** | high |
| **Preconditions** | Stage 8 complete |
| **Operator actions** | Induce a storage read failure — e.g. corrupt or remove the persisted document from the userscript manager, or simulate an unavailable GM store |
| **Expected** | The failure is recorded; storage health goes unhealthy; `DEGRADED_READ_ONLY` is entered; automatic execution pauses; new irreversible actions are refused; read-only inspection still works; a persistent warning offers Export / Retry / Reset |
| **Forbidden** | A silent failure; continuing to act; discarding the persisted document |
| **Evidence** | `storage.read.failed` with the error and duration; `storage.health.changed` with `healthy: false`; a `gate.blocked` with reason `storage-unhealthy` |
| **Pass** | Degraded visibly; execution refused; inspection still available. **Automatic sends never continue without reliable persistence**, because duplicate-prevention state could not be recorded |
| **Bundle** | required |
| **Next allowed** | T91 |

### T91 — Storage write failure

| Field | Value |
|---|---|
| **Name** | Storage write failure |
| **Risk** | critical |
| **Preconditions** | T90 passed |
| **Operator actions** | Induce a storage write failure with an intent armed |
| **Expected** | The write failure is recorded; health goes unhealthy; the action is refused |
| **Forbidden** | Proceeding to an irreversible action whose duplicate-prevention state could not be persisted. **No send while storage is unhealthy** |
| **Evidence** | `storage.write.failed` with the error; `storage.health.changed`; a `gate.blocked` with reason `storage-unhealthy`; no `communication.send.clicked` after it |
| **Pass** | Refused; no send |
| **Bundle** | required |
| **Next allowed** | T92 |

### T92 — Corrupted persisted document

| Field | Value |
|---|---|
| **Name** | Corrupted persisted document |
| **Risk** | high |
| **Preconditions** | T91 passed |
| **Operator actions** | Write malformed JSON into the persisted document by hand, then reload |
| **Expected** | The load fails loudly; JobPilot enters read-only and refuses to save; it does **not** overwrite the document with defaults |
| **Forbidden** | Silently replacing the document with defaults; losing a recoverable document |
| **Evidence** | `storage.read.failed`; the load error path; an unchanged document afterwards |
| **Pass** | Refused and preserved. The trade-off is documented: nothing persists until you clear the document or run a build that understands it |
| **Bundle** | required |
| **Next allowed** | T93 |

### T93 — Unsupported schema

| Field | Value |
|---|---|
| **Name** | A document from a newer schema |
| **Risk** | high |
| **Preconditions** | T92 passed |
| **Operator actions** | Write a document whose `schemaVersion` is higher than this build supports, then reload |
| **Expected** | Refused outright and **left on disk untouched**, because downgrading by guessing would drop fields the current build cannot see |
| **Forbidden** | Downgrading and guessing; overwriting the document |
| **Evidence** | The refusal recorded; the document byte-identical afterwards |
| **Pass** | Refused, untouched |
| **Bundle** | required |
| **Next allowed** | T94 |

### T94 — Migration failure

| Field | Value |
|---|---|
| **Name** | A migration that fails |
| **Risk** | high |
| **Preconditions** | T93 passed |
| **Operator actions** | Present a document that triggers a failing migration path |
| **Expected** | The migration failure is recorded; JobPilot does not continue on a half-migrated document |
| **Forbidden** | Destroying user data in a migration; continuing on a partially-migrated document. Migrations are additive and never destroy user data |
| **Evidence** | `migration.failed` with the error; the resulting read-only state |
| **Pass** | Recorded; no destructive write |
| **Bundle** | required |
| **Next allowed** | Stage 10 |

---

# Stage 10 — Batch behaviour

Small batches, to prove the queue drives sends for more than one job.

### T100 — Two-job batch

| Field | Value |
|---|---|
| **Name** | Two-job batch |
| **Risk** | critical |
| **Preconditions** | Stage 9 complete; exactly two jobs explicitly selected |
| **Operator actions** | Queue exactly two jobs and run them to completion with the operator present |
| **Expected** | Both processed in order; a complete trace per job; distinct transaction ids; the queue reaches a terminal state for each |
| **Forbidden** | Any job processed twice; a third job contacted; a send without a persisted intent |
| **Evidence** | Two complete transaction traces in `transactions.json`, each with `communication.send.attempt.persisted` preceding `communication.send.clicked`; `queue.item.completed` per item; two distinct `jobId`s |
| **Pass** | Two sends, two jobs, two traces, no duplicates |
| **Bundle** | required |
| **Next allowed** | T101 |

### T101 — Three-job batch

| Field | Value |
|---|---|
| **Name** | Three-job batch |
| **Risk** | critical |
| **Preconditions** | T100 passed; exactly three jobs explicitly selected |
| **Operator actions** | Queue exactly three jobs and run them to completion |
| **Expected** | Same guarantees as T100, extended to three; limits and pacing respected; no item starved and none repeated |
| **Forbidden** | Exceeding the per-session or per-hour caps; a fourth job contacted; any send without a persisted intent |
| **Evidence** | Three complete transaction traces; `gate.passed` / `gate.blocked` records for the limit gates; queue snapshots showing the ordering |
| **Pass** | Three sends, three jobs, three traces, limits respected. Where a limit is reached, the refusal is a legitimate pass — `gate.blocked` with reason `session-limit` or `hourly-limit` |
| **Bundle** | required |
| **Next allowed** | (end of matrix) |

---

# Progression rules

A failed scenario **blocks all later higher-risk stages.** There is no exception.

```
Stage 0  ->  Stage 1  ->  Stage 2  ->  Stage 3
                                        |
                                        v
                                    Stage 4  ->  Stage 5  ->  Stage 6
                                                                |
                                                                v
                                     Stage 10 <- Stage 9 <- Stage 8 <- Stage 7
```

Rules:

1. **A row may only run if its "Next allowed" precondition is satisfied.** Rows
   are not independent; the "Next allowed" column is the dependency edge.
2. **A failed scenario blocks every later higher-risk stage.** You may not
   "work around" a failure to reach a more interesting row.
3. Explicit example: **if T44 (chat identity verification) fails, T60 must not
   run.** Identity verification is the gate that prevents sending into the wrong
   conversation. Proceeding to a real send with a known-broken identity check is
   exactly the failure the whole safety model exists to prevent.
4. The same applies in every stage: if any Stage 0–5 row fails, Stage 6 is
   blocked until it passes twice. If a Stage 7 interruption row fails, Stages 8–10
   are blocked — an interruption bug around the send boundary is a duplicate-send
   bug.
5. A blocked stage is legitimate. Record it, export the bundle, and go to
   [`FAILURE_TRIAGE.md`](./FAILURE_TRIAGE.md). A stage blocked with evidence is
   progress; a stage skipped without one is not.
6. Lower-risk rows in the **same** stage may continue if the failure does not
   invalidate their preconditions. Higher-risk stages never may.

---

# Repetition rule

**Critical scenarios must pass twice after a fix before being marked stable.**

1. A row is `UNSTABLE` after its first pass. One pass is an anecdote.
2. After a fix, re-run the **same** scenario from a clean build, as a new
   `run-NNN` directory. Do not overwrite the previous run.
3. The scenario is `STABLE` only after **two consecutive passes on the same
   build**, with:
   - identical expected behaviour, and
   - nothing in the Forbidden column, and
   - a bundle for each run, and
   - `pnpm diag:compare run-a.zip run-b.zip` showing no new failure and no
     unexplained timing regression. (Where `diag:compare` is not yet implemented
     on your build, compare `machine-summary.json` from each run by hand and say
     in the notes that the comparison was manual.)
4. Any `critical` row (T27, T41–T48, T53, T60, T71–T76, T82–T84, T91, T100,
   T101) must additionally satisfy the "Definition of ready" checklist below
   before it is marked stable.
5. A pass on a **different** build does not count toward the two. The build
   identity is recorded in the manifest for this reason.
6. If a regression is found later, the row returns to `UNSTABLE` and the two-pass
   count restarts.

---

# Definition of ready for the first real send

T60 may not run until **every** item below is true. This mirrors the phase
brief's list.

- [ ] **Every Stage 0–5 scenario has passed twice**, on the same build, with a
      bundle for each run and no forbidden behaviour.
- [ ] **T44 (chat identity verification) has passed twice**, including T45 (wrong
      chat rejected) — the gate that prevents sending into the wrong conversation.
- [ ] **T46 (draft protection) and T73 (user types before send) have passed
      twice** — user content is never overwritten.
- [ ] **T71 (refresh after `send-attempted`) has passed twice** — the
      duplicate-send prevention survives a reload.
- [ ] **T76 (unobservable outcome) has passed twice** — an ambiguous send becomes
      `uncertain` and is never rounded to success or auto-retried.
- [ ] **Stage 9 storage rows have passed**, and `DEGRADED_READ_ONLY` correctly
      refuses new irreversible actions.
- [ ] **Stage 8 ownership rows have passed** — no second tab can execute the same
      queue.
- [ ] **Exactly one job is explicitly selected** for the send. Not "select all
      accepted". One.
- [ ] **The operator is present throughout** the transaction and can stop it.
- [ ] **Mode is `assist`.** The default. A send at `automatic` mode is not part of
      this phase.
- [ ] **All local gates pass on the exact build under test** — `pnpm check`
      (typecheck, lint, test, build, verify:dist) — and the commit is recorded.
- [ ] **The privacy test passes** on that build.
- [ ] **The run directory exists** and the operator has the scenario notes
      prepared, so the bundle has somewhere to go.
- [ ] **You have read [`RUNBOOK.md`](./RUNBOOK.md) §5 and §6** and know what to do
      if the export fails.

If any box is unchecked, **do not send.** Run more scenarios instead.
