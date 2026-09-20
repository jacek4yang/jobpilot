# Failure triage

How to turn an exported bundle into a diagnosis.

The governing principle, from
[`../diagnostics/ARCHITECTURE.md`](../diagnostics/ARCHITECTURE.md):

> If a real-site failure cannot be reconstructed from the exported bundle, the
> diagnostics are not good enough.

Each section below maps one failure class to: the symptom you observed, the files
to open **first**, what `confirmed` / `likely` / `unknown` evidence looks like for
that class, and the next action.

> **No live-site verification has occurred.** Every failure class here is written
> from the design and from fixture-level behaviour. None has been observed on the
> real BOSS site, because no JobPilot build has been run against it. Treat the
> "next action" in each section as the procedure to follow, not as a record of
> something already fixed.

---

## 0. How to read a bundle

### Ground rules

1. **Open `summary.txt` first, always.** It answers "what went wrong" without
   opening the event log. It gives you version, commit, scenario, session, final
   status and state, route, current job, queue counts, transaction status, fatal
   error, first important failure, whether human verification was hit, storage
   health, lock owner, and event/snapshot counts.
2. **`sequence` is the join key, never a timestamp.** `wallTime` can jump; two
   events can share a millisecond. `monotonicTime` is for measuring races —
   only differences are meaningful.
3. **Read `event`, not the rendered text.** The human-readable strings are for
   the UI only. Event names are stable, dot-namespaced values from `EVENTS` in
   `src/diagnostics/event.ts`.
4. **First divergence, not the loudest error.** The first thing that went wrong
   is the cause; everything after it is usually a consequence. `summary.txt`
   picks the first `fatal`, else the first `error.invariant_violation`, else the
   first `error` — deliberately.
5. **"Nothing happened" is evidence.** Rejected and ignored transitions are
   recorded. A gate that refused is as important as a gate that passed.

### Files, and what to open first for what

| Question | Open first |
|---|---|
| What went wrong overall? | `summary.txt` |
| Was this bundle even produced by the build I think? | `manifest.json`, `build.json` |
| What happened, in order? | `events.ndjson` |
| Where did a state machine stop? | `state-transitions.ndjson` |
| Why did a selector fail? | `selector-diagnostics.json` |
| What did the page look like? | `dom-diagnostics.json` |
| What happened in a send transaction? | `transactions.json` |
| Was the queue the problem? | `queue.json` |
| Was persistence the problem? | `storage-summary.json` |
| Was there a crash or an invariant violation? | `errors.json` |
| Is the archive intact? | `checksums.json` and `manifest.json` |

If a bundle fails checksum verification, **stop**. The evidence is not the
evidence that was exported. Re-export.

### The analyzer

```bash
pnpm diag:analyze <bundle.zip>
```

produces `diagnostic-analysis/<session-id>/` with `report.md`, `timeline.md`,
`selector-report.md`, `transaction-report.md` and `machine-summary.json`, and
labels every finding. Use

```bash
pnpm diag:compare <a.zip> <b.zip>
```

to ask the iteration questions: did the failure disappear, did the workflow
progress further, did a new failure appear, did timing regress.

### The three evidence labels

The analyzer labels every finding. The labels are a contract, and you should
apply the same standard when reading a bundle by hand.

| Label | Means | You may |
|---|---|---|
| **confirmed** | A deterministic artefact proves it. A recorded event with the failure, a selector outcome with its rejection reason, an invariant violation, a state transition that contradicts the spec. | Fix the root cause and add a regression test. |
| **likely** | The evidence points one way but something is inferred — a missing event, a timing gap, an absence of a counter-event. | Investigate further before fixing. Prefer reproducing with a fixture; if you cannot, say so. |
| **unknown** | The evidence is thin or ambiguous. | **Do not guess.** Record it, add a test, and extend the diagnostics (see §13). |

**The analyzer does not invent a diagnosis when evidence is thin, and neither
should you.** An `unknown` that is honestly reported is more valuable than a
`likely` that is wrong, because the wrong one gets "fixed".

---

## 1. DOM_CHANGED / selector miss

**Symptom.** JobPilot fails to find an element it expects. A workflow stops with
`DOM_CHANGED`, a `FAILED(DOM_CHANGED)`, or a skip. The panel shows a step that
never completes. Nothing is sent or clicked.

This is the single most likely failure on first contact with the real site.
`README.md` §Known limitations 1: the BOSS adapter has never been run against the
real DOM, and roughly one in three selectors is an outright guess.

**Open first:** `selector-diagnostics.json`, then `dom-diagnostics.json`, then
`summary.txt`.

**Look for.**

- `selector.miss` — the selector matched nothing.
- `selector.ambiguous` — the selector matched something, but context validation
  rejected it, or it matched several candidates where one was required.
- `selector.match` — what *did* match, with its declared confidence.

Selector instrumentation records, **per candidate**: the selector itself, its
declared confidence (`fixture-only` or `unverified` — there is no `verified`
value), the raw match count, the visible match count, the context-validation
result, and the accept/reject reason.

**Evidence quality.**

- **confirmed** — a `selector.miss` for the exact selector, with the candidate
  list and rejection reasons, and the element's absence corroborated by
  `dom-diagnostics.json` showing what was in the ancestry and nearby elements
  instead. The bundle tells you what the page had where the element should have
  been.
- **likely** — a `selector.miss` is present but the DOM section is empty or the
  fingerprint is too shallow to say what the page actually was. You know it
  failed; you do not know what it failed against.
- **unknown** — no selector events at all in the window. Either the group was
  never reached (a different failure upstream), or instrumentation for that group
  is missing. Check the timeline before concluding anything.

**Next action.**

1. Establish whether this is a **miss** (wrong selector) or an **ambiguity**
   (right selector, wrong context validation). They have different fixes.
2. Extract the minimal structural fact — the element, its attributes, its
   ancestry — from `dom-diagnostics.json`. Add a sanitized fixture under
   `tests/fixtures/boss/` capturing only that fact.
3. Write a failing test. Fix the selector registry entry.
4. **Do not add a text-based fallback.** JobPilot fails closed: an unmatched apply
   button is `selector-missing` with no fallback, by design.
5. Do not promote the selector's confidence beyond `fixture-only` on the strength
   of a passing fixture test. Confidence is raised on cited live evidence.
6. If the same selector missed on a page where it previously matched, run
   `pnpm diag:compare` against the earlier bundle before changing anything — a
   regression and an unverified guess look identical from one bundle.

---

## 2. CHAT_MISMATCH

**Symptom.** The transaction cannot confirm which conversation it is in. It ends
`FAILED(CHAT_MISMATCH)`, or the panel reports that the conversation could not be
confirmed as the right one. **Nothing is typed and nothing is sent.**

This is the safety-critical failure class. Sending into the wrong conversation is
a **privacy failure, not a bug** (see
[`../product/boss-workflows.md`](../product/boss-workflows.md) §4).

**Open first:** `transactions.json`, then `selector-diagnostics.json` for the chat
identity group, then `dom-diagnostics.json`.

**Look for.** The identity sequence:

```
communication.modal.observed
chat.candidate.detected
chat.identity.evaluated
chat.identity.matched   OR   chat.identity.rejected
```

`chat.identity.evaluated` records the evidence used. Identity is verified with a
strict precedence:

1. If a job id is present in the chat → ids must intersect, else `MISMATCH`.
2. If no job id → require **title AND (company OR recruiter)**, else `MISMATCH`.
3. Contradictory evidence → `MISMATCH` (conservative).

Text normalisation for comparison strips whitespace, `·•-—_()（）` and common
company suffixes (`股份有限公司`, `有限责任公司`, `有限公司`).

Also check: stability. The conversation must be stable for `chatStableMs` before
verification. A `chat.identity.matched` that was never followed by progress may
mean stability was never reached — that is a timing problem, not a parsing one.

**Evidence quality.**

- **confirmed** — `chat.identity.rejected` with the reason recorded, plus the
  element fingerprints for the chat header showing what was actually there. You
  can see *why* it did not match.
- **likely** — a `chat.identity.rejected` with a reason, but the fingerprints are
  truncated or the title/company comparison text was hashed (which it is, when it
  is user content). You know the verdict, not the diff.
- **unknown** — the transaction shows the *absence* of identity events. That
  means evaluation never ran, which is an upstream failure (chat candidate never
  detected), not a mismatch. Do not treat a missing evaluation as a rejection.

**Next action.**

1. Read the recorded reason. `MISMATCH` with a present job id is a **different
   bug** from `MISMATCH` with no job id — the first is an id-extraction problem,
   the second is a title/company comparison problem.
2. If it is a reject and you believe it should have matched, **the conservative
   direction is correct**. Prefer the false rejection. Verify the comparison
   inputs before weakening anything.
3. Reproduce with a chat fixture (`tests/fixtures/boss/chat-wrong-conversation.html`
   and `chat-conversation.html` exist for this). Fix identity extraction.
4. **Never** weaken the identity rule to make a scenario pass.
5. If T44 fails, T60 must not run — see the progression rule in
   [`TEST_MATRIX.md`](./TEST_MATRIX.md).

---

## 3. SEND_UNCERTAIN

**Symptom.** A message may have been sent and JobPilot cannot prove it. The
transaction is `uncertain`, shown as a first-class state with its own badge.

**This is a stop condition.** Do not retry. Do not reload to "try again".

**Open first:** `transactions.json`, then `summary.txt`, then `events.ndjson`
around the transaction.

**Look for.** The ordered trace around the point of no return:

```
message.prepared
communication.send.attempt.persisted     <-- persisted BEFORE the click
communication.send.clicked
communication.verification.started
communication.outgoing.found            <-- the ONLY evidence of success
communication.transaction.committed  OR  communication.transaction.uncertain
```

Verification counts outgoing messages matching the intended text against the
recorded `outgoingBaseline`:

- count **increased** → `verified`
- count **equals** the baseline → `uncertain`, **not** `failed`
- timeout or ambiguity → `uncertain`

**Evidence quality.**

- **confirmed** — `communication.send.attempt.persisted` is present, no
  `communication.outgoing.found` follows, and the verification window closed.
  The click may or may not have landed; either way the outcome is genuinely
  unobservable and `uncertain` is the correct verdict.
- **likely** — the ordering is present but the verification window is unclear, or
  the outgoing-message observation never started. You believe it is uncertain;
  you cannot show the window closed without an observation.
- **unknown** — `communication.outgoing.found` is present *and* the transaction
  is `uncertain`. That is a contradiction and is itself a defect in the
  transaction logic, not a site problem. Report it as such.

**Next action.**

1. **Resolve it in the BOSS UI, by hand.** Look at the conversation. Either the
   message is there or it is not. JobPilot will not do this for you and must not.
2. Record the resolution in the run notes.
3. If the message is there, the transaction should resolve to verified. If it is
   not, do not resend automatically — check whether the click was dispatched
   (`clickDispatched` in the persisted intent) before deciding.
4. Whatever the outcome, this is a **finding worth a regression test**. The
   `uncertain` path is the one that most needs to be provably correct, because
   getting it wrong means sending twice.
5. Never round `uncertain` to `failed` or to success. It is never auto-retried.

---

## 4. LOCK ownership lost / duplicate processing

**Symptom.** Two tabs appear to be acting, or a tab acts when it should not. The
UI says another tab is running, or ownership changed unexpectedly. A job is
processed twice.

**Open first:** `summary.txt` (for the lock owner), then `events.ndjson`
filtered to `category: "lock"`, then `queue.json`.

**Look for.** The lock lifecycle events:

```
lock.requested   lock.acquired   lock.rejected
lock.renewed     lock.released   lock.lease.expired   lock.ownership.changed
```

each carrying `tabId`, `ownerId`, and on acquisition an `expiresAt`. The tracer
records the full requested/acquired/rejected/renewed/released sequence precisely
so ownership at any instant is reconstructable.

Also relevant: `lock.ownership.changed` is emitted by `currentHolder()`, and
carries `holder` and `isOwner` as computed at that moment.

**Evidence quality.**

- **confirmed** — the event sequence shows two tabs each with `lock.acquired` and
  overlapping lease windows, or execution events (`queue.item.started`,
  `effect.started`) attributed to a `tabId` that did not hold the lease. The
  bundle proves the overlap.
- **likely** — `lock.rejected` appears with a `holder`, but the holder's renewal
  history is incomplete or the tab ids are not distinguishable in the way you
  need. Ownership looks wrong; the proof has a gap.
- **unknown** — duplicate processing with no lock events at all. Either the lock
  was never consulted on that path, or the tracer is not wired into it. That is a
  diagnostics gap (§13), not a diagnosis.

**Next action.**

1. Reconstruct the ownership timeline. Place every `lock.acquired` /
   `lock.released` / `lock.lease.expired` on the `sequence` axis and find the
   overlap (if any).
2. If two owners overlap: the lease TTL, the renewal cadence, or the acquisition
   path is wrong. Fix in the lock adapter, not at the call site.
3. If a non-owner executed: the `not-owner` gate was not evaluated on that path.
   Gates are evaluated at the **arm** point, not at the click — a gate checked at
   the click is not a gate.
4. Reproduce with the async `LockManager` fake used by
   `tests/unit/adapters/navigator-lock.test.ts`. Note the honesty caveat: that
   fake is not two real tabs, which is why T80–T85 exist.
5. Verify the invariant holds: **no second tab executing the same queue.**
6. On any window where a takeover happened, confirm the new owner **re-read the
   live intent** and applied the recovery rules rather than replaying.

---

## 5. Storage DEGRADED_READ_ONLY

**Symptom.** The panel shows a persistent warning with Export / Retry / Reset.
Automatic execution has paused. New irreversible actions are refused.

This is **JobPilot working correctly.** The failure is the storage problem, not
the degradation.

**Open first:** `storage-summary.json`, then `summary.txt` (the Health block),
then `events.ndjson` filtered to `category: "storage"`.

**Look for.**

```
storage.read          storage.read.failed
storage.write         storage.write.failed
storage.health.changed   { healthy: false, error }
migration.applied     migration.failed
```

Each records the operation, the key namespace, the duration, the serialised byte
size on success, and the error on failure. **Never the stored value.**

Then find the refusal it caused: a `gate.blocked` with reason
`storage-unhealthy`.

**Evidence quality.**

- **confirmed** — `storage.read.failed` or `storage.write.failed` with an error
  message and duration, followed by `storage.health.changed` with
  `healthy: false`, followed by a `gate.blocked` with `storage-unhealthy`, and no
  `communication.send.clicked` after it. The whole chain is present.
- **likely** — the failure and the health change are present but the refusal is
  not visible, or the refusal appears without a preceding health change. The
  behaviour looks right; the causal link is incomplete.
- **unknown** — read-only mode with no storage failure events. Health was set
  unhealthy by something that did not record. That is a gap.

**Next action.**

1. Read the error in `storage-summary.json`. Is it quota, an unavailable GM
   store, a permissions problem, or a serialisation failure?
2. Distinguish **read** from **write** failure. A read failure on boot means the
   document could not be loaded; a write failure with an intent armed is far more
   serious and should have blocked the send.
3. Confirm the degraded behaviour is correct: execution paused, irreversible
   actions refused, **read-only inspection still working**, warning visible,
   **Reset requires explicit confirmation**.
4. Confirm the invariant: **no send while storage is unhealthy.** No
   `communication.send.clicked` after the health change, in `sequence` order.
5. Recover via Retry (which performs a probe read) or Reset (explicit
   confirmation). If the document is corrupted or from a newer schema, the
   correct behaviour is refusal and preservation — see Stage 9 rows T92/T93/T94.
6. Never let a test continue past this state "to see if it recovers".

---

## 6. Human verification encountered

**Symptom.** A CAPTCHA, security verification, identity verification,
login-required page or an operation-too-frequent warning appeared. JobPilot
entered `BLOCKED_HUMAN_VERIFICATION` and stopped.

This is **JobPilot working correctly.** JobPilot performs no action to resolve a
verification page.

**Open first:** `summary.txt` (the Health block reports whether human
verification was encountered), then `events.ndjson` filtered to
`category: "risk"`.

**Look for.**

```
risk.captcha.detected
risk.security_verification.detected
risk.login.detected
risk.risk_control.detected
risk.too_frequent.detected
risk.unknown_modal.detected
risk.human_verification.recheck      (only after the operator acts)
risk.human_verification.resolved
```

and the surrounding evidence: the pending safe effects being cancelled, the
persisted transaction evidence being **retained**, and no action events in the
window afterwards.

**Evidence quality.**

- **confirmed** — the risk event is present, the block transition follows it, and
  **zero** action events appear between them. JobPilot detected and stopped.
- **likely** — the block is present with the risk event, but you cannot fully
  exclude an action in the same window because events from the site's own
  rendering muddle the picture.
- **unknown** — a blocked state with no risk event that explains it. Something
  blocked without recording why.

**Next action.**

1. Confirm the three entry requirements were met: **stop actions immediately**,
   **cancel pending safe effects**, **do not cancel persisted communication
   evidence**, and **do not touch verification widgets**.
2. Confirm the panel shrank out of the way.
3. Recovery is **strictly two-step and never automatic**:
   - the user completes the challenge in the BOSS UI by hand;
   - the user presses **Re-check page**;
   - JobPilot validates: login valid, risk UI gone, route sane, transaction state
     safe, persistence healthy, queue ownership valid;
   - the panel shows **Ready to resume**;
   - the user explicitly presses **Resume**.
4. **The challenge disappearing is never sufficient to resume.** If the bundle
   shows a resume without `risk.human_verification.recheck` and an explicit
   resume, that is a defect.
5. An ambiguous `send-attempted` transaction is **never** resumed by resending.
6. The invariants to verify: `NO_AUTOMATIC_ACTION_DURING_HUMAN_VERIFICATION`,
   and on an unknown modal `NO_CONTINUATION_THROUGH_UNKNOWN_MODAL`.

---

## 7. Unknown modal

**Symptom.** A dialog appeared that JobPilot does not recognise. The transaction
is `BLOCKED(UNKNOWN_MODAL)`.

This is **JobPilot working correctly.**

**Open first:** `dom-diagnostics.json` (the modal's structure), then
`events.ndjson` filtered to `risk.unknown_modal.detected` and
`communication.modal.observed`.

**Look for.**

- `communication.modal.observed` with the classification.
- `risk.unknown_modal.detected`.
- The modal's element fingerprint — tag, id, classes, role, aria-label, selected
  `data-*` attributes, a text fingerprint, and a rect. **Not** its HTML, which is
  never exported.

**Evidence quality.**

- **confirmed** — the modal was observed, classified unknown, and the transaction
  blocked with zero interaction with it. The fingerprint is present so you can
  see what it actually was.
- **likely** — the block is present but the fingerprint is too shallow to
  identify the dialog.
- **unknown** — an unexplained block with no modal event.

**Next action.**

1. Identify the dialog from the fingerprint: an announcement, a survey, a
   rate-limit notice, a page-kind change?
2. Decide whether it is genuinely *unknown* or a **known modal that is not yet
   modelled**. Those are different fixes:
   - If it should be modelled as a success modal, that is a classification gap —
     add it to the registry with a fixture.
   - If it should block, it already does. Confirm nothing touched it.
3. The invariant is `NO_CONTINUATION_THROUGH_UNKNOWN_MODAL`. Verify nothing was
   dismissed, clicked or navigated around.
4. Be conservative. A modal wrongly treated as success is far worse than one
   wrongly treated as unknown.

---

## 8. State stall / watchdog

**Symptom.** The machine stops making progress without an error. The panel shows
a state that never changes. The watchdog pauses the machine.

**Open first:** `state-transitions.ndjson`, then `events.ndjson` around the last
transition, then `summary.txt` for the final state.

**Look for.**

- The **last** `state.transition` and the state it entered. `summary.txt`
  reports `final state` from the last event carrying a `state`.
- The **dwell time** in the `from` state — the tracer records how long the
  machine sat there.
- `state.transition.rejected` — the reducer returns the context unchanged for an
  illegal event, and that "nothing happened" is recorded because it is
  diagnostically important. A rejected transition is often the whole answer.
- `effect.timed_out` for whatever effect should have completed.
- `diagnostics.buffer.truncated` — if `trace` noise evicted the relevant window
  you may be looking at a gap, not a stall.

**Evidence quality.**

- **confirmed** — the last transition into the stalled state, an expected effect
  that never completed, and a measured dwell time exceeding its budget, all with
  `monotonicTime` deltas. You can say exactly where it stopped and for how long.
- **likely** — the stall is visible but the expected effect is not identifiable,
  because the effect that should have run was never started. You know it stalled;
  you cannot yet say what it was waiting for.
- **unknown** — the buffer was truncated around the stall window, or there are no
  transitions at all.

**Next action.**

1. Identify the state it is stuck in and the effect that should have completed.
2. Check for a **rejected transition**: the event it needed may have been
   delivered and refused as illegal. A rejection is a rule bug, not a timing bug.
3. Distinguish three cases:
   - **effect never started** — the reducer did not produce it;
   - **effect started, never completed or timed out** — a missing timeout budget;
   - **effect completed, no transition followed** — a lost event or a guard.
4. If the watchdog fired, confirm it did the right thing (paused the machine,
   did not resume automatically).
5. If the evidence was evicted by truncation, that is a §13 problem: the critical
   buffer should have kept it. Critical categories are communication,
   chat-identity, verification, risk, error, lock and storage.

---

## 9. Retry exhaustion

**Symptom.** A bounded retry gave up. The item fails with `DETAIL_TIMEOUT` or
`CHAT_MISMATCH` after the maximum attempts, or a retryable failure escalated.

**Open first:** `events.ndjson` filtered to `category: "retry"` and
`category: "effect"`, then `queue.json`, then `summary.txt`.

**Look for.**

- `effect.started` / `effect.failed` / `effect.timed_out` pairs, each with a
  duration. A retry shows as repeated start/fail pairs for the same correlation
  ids.
- The `attempts` count on `queue.item.started`, which the queue tracer records.
- `queue.item.failed` with the error.
- Rate-limit interaction: `category: "rate-limit"` events, and
  `gate.blocked` with reason `rate-limited`.

**Check the retryability of the failure class**, because retrying the wrong thing
is itself a bug. From `docs/product/boss-workflows.md` §11:

| Non-retryable — must never be auto-retried |
|---|
| `DRAFT_PRESENT` |
| `SEND_UNCERTAIN` |
| `RISK_CONTROL` |
| `LOGIN_REQUIRED` |

If the bundle shows a retry of one of these, that is a **defect**, not a site
problem.

**Evidence quality.**

- **confirmed** — the full retry sequence with attempt counts, durations, and the
  terminal failure, and the failure class being one that is legitimately
  retryable.
- **likely** — the retries are visible but the exact attempt count or the
  backoff timing is unclear.
- **unknown** — a terminal failure with no visible retry history.

**Next action.**

1. Confirm the failure class is retryable. If not, stop and treat it as a defect.
2. Check the **consecutive-failure** threshold: repeated failures must stop the
   run, which protects against a broken DOM being hammered. If it retried past
   the threshold, that is a defect.
3. Check the backoff was applied, not a tight loop.
4. If exhaustion is genuine and the failure is a selector problem, this is really
   §1 — go back to the DOM evidence.

---

## 10. Route changed during action

**Symptom.** The page navigated while JobPilot was mid-action. A transaction
aborts, or a page is reclassified mid-flight.

**Open first:** `events.ndjson` for `route.changed` and its neighbours, then
`transactions.json` if a transaction was involved.

**Look for.**

- `route.changed` with a `routeId`, and `page.detected` following it.
- The action events immediately **before** the change — which effect was running
  when the route moved.
- Whether the route change was **user-initiated** (`user.changed_route`) or
  site-initiated.

**The rule that matters most.** If the conversation changes during any step, the
transaction aborts to `uncertain` if the send was already attempted, or `failed`
if it was not, and **the user's content is never modified** (Invariant C1).

**Evidence quality.**

- **confirmed** — `route.changed` with a `routeId`, bracketed by the action events
  it interrupted, on the `sequence` axis. You can see exactly which effect was
  in flight.
- **likely** — the route change is present but you cannot tell whether the
  interrupted action had already dispatched something irreversible. Check
  `communication.send.attempt.persisted` / `communication.send.clicked`
  specifically.
- **unknown** — an abort with no route event. Something changed the page without
  it being recorded.

**Next action.**

1. Determine whether an irreversible step had already happened. If
   `send.clicked` precedes the route change → `uncertain`, and §3 applies.
2. If nothing irreversible happened: it should be `failed`, the item requeued or
   skipped, and the user's content untouched.
3. Confirm the invariant: `NO_AUTOMATIC_SEND_AFTER_AMBIGUOUS_RELOAD`.
4. If the route change was user-initiated, confirm JobPilot **yielded** rather
   than competing.

---

## 11. Duplicate processing

**Symptom.** The same job is processed twice — two queue entries, two
transactions, or (worst case) two messages.

This is a `critical` failure. Duplicate-send prevention has **five independent
layers**, any one of which alone should suffice:

```
Layer 1  platform state      "继续沟通" / "已沟通" → treat as contacted
Layer 2  application history job id already has outcome contacted/verified
Layer 3  live intent         an active intent exists for this job id
Layer 4  outgoing message    the intended text already exists in the chat
Layer 5  queue dedup         job id cannot be enqueued twice
```

**Open first:** `events.ndjson` and `transactions.json` filtered to the job id,
then `queue.json`, then `summary.txt`.

**Look for.**

- The job id across the whole stream. Every event carries `jobId` when relevant,
  and `queueItemId` for queue events.
- `queue.item.duplicate` — emitted by the queue tracer when `enqueue` is refused.
- `queue.item.enqueued` appearing **twice** for one job id.
- Two `communication.intent.created` for one job id — the second should have been
  `FAILED(DUPLICATE_INTENT)`.
- Two `communication.send.clicked` for one `transactionId` — the invariant
  `NO_SECOND_SEND_AFTER_ATTEMPT` is exactly this.
- `communication.outgoing.found` counting.

**Which layer failed.** The bundle tells you:

| Observation | Layer that failed |
|---|---|
| Two `queue.item.enqueued` for one id | Layer 5 (queue dedup) |
| Two intents for one id | Layer 3 (live intent) |
| A send with no preceding intent check | Layer 3, at the gate |
| A job contacted whose platform state said contacted | Layer 1 (platform state parsing) |
| The intended text already in the chat, and it sent again | Layer 4 |

**Evidence quality.**

- **confirmed** — two complete, distinct traces for one job id with the ordering
  preserved. There is no ambiguity about what happened.
- **likely** — duplication is visible but one of the two traces is incomplete
  (truncated, or the second transaction is missing its early phases).
- **unknown** — the job appears twice in the queue but there is only one
  execution. That may be a rendering problem, not a duplicate.

**Next action.**

1. **Stop the run.** A duplicate-processing bug is a blocker.
2. Identify the failed layer from the table above.
3. Note the policy: **prefer a false skip over a duplicate send.** If layers 1 or
   4 are ambiguous, the correct behaviour is to skip and label the item `already
   contacted (assumed)`. Finding that JobPilot *skipped* when it could have sent
   is a finding in the safe direction; the reverse is not.
4. Fix the layer, then add a regression test that proves the specific layer now
   holds.
5. Re-run the scenario twice (repetition rule) before advancing.

---

## 12. Invariant violations

An `error.invariant_violation` is **fatal by design**. Continuing past one would
mean sending into an unverified conversation or sending twice, which is exactly
what the safety model exists to prevent.

They are recorded by `reportInvariantViolation` with the invariant id, a detail
string, and optional context. `summary.txt` prioritises an invariant violation
over a plain error for the "Primary failure" line, because it is more specific.

The real identifiers, from `INVARIANTS` in `src/application/gates.ts`:

| Invariant id | Means | Investigate with |
|---|---|---|
| `NO_SEND_WITHOUT_PERSISTED_INTENT` | A send happened with no durable intent to recover from | §3, §11 — check `communication.send.attempt.persisted` ordering |
| `NO_SEND_WITHOUT_VERIFIED_CHAT` | A send happened without confirmed identity | §2 |
| `NO_SEND_WHILE_STORAGE_UNHEALTHY` | A send happened while persistence was unreliable | §5 |
| `NO_SEND_WITHOUT_QUEUE_OWNERSHIP` | A send happened without the lock | §4 |
| `NO_SEND_WITH_DRAFT_PRESENT` | A send overwrote or ignored a user draft | §7 / T46, T73 |
| `NO_SECOND_SEND_AFTER_ATTEMPT` | A second click was dispatched after `send-attempted` | §3, §11 |
| `NO_AUTOMATIC_ACTION_DURING_HUMAN_VERIFICATION` | JobPilot acted on a verification page | §6 |
| `NO_CONTINUATION_THROUGH_UNKNOWN_MODAL` | JobPilot continued past an unrecognised dialog | §7 |
| `NO_AUTOMATIC_SEND_AFTER_AMBIGUOUS_RELOAD` | A reload replayed an ambiguous send | §3, §10 |
| `NO_SECOND_TAB_EXECUTING_QUEUE` | Two tabs drove the same queue | §4 |

**Gate reasons**, from `GateReason` in the same file, appear in `gate.blocked`
events as `data.reason`. A gate refusal is **not** a violation — it is the gate
working. Distinguish them carefully:

```
mode               human-verification   storage-unhealthy   not-owner
session-limit      hourly-limit         rate-limited        draft-present
chat-unverified    no-intent            already-attempted
```

`already-attempted` is checked **last** and is absolute: once a click has been
dispatched, no gate ordering or state change can authorise another.

**Next action for any violation.** Treat it as a release blocker. Reproduce with
a fixture, fix the root cause, add a regression test asserting the invariant, and
re-run the scenario twice. Do not reclassify a violation as a site problem.

---

## 13. When the bundle is insufficient

The governing principle is that a real-site failure must be reconstructable from
the bundle. When it is not, **the diagnostics are not good enough** — that is a
finding about the diagnostics, and it goes in the report.

Do not work around a gap by guessing. Record it explicitly as
`evidence insufficient: <what is missing>`, and add to diagnostics *next*.

### Recognising insufficiency

- The relevant window was evicted by `diagnostics.buffer.truncated`.
- A selector group produced **no events at all**, not even a miss — meaning the
  instrumentation does not cover that group.
- A subsystem section (`queue.json`, `transactions.json`,
  `selector-diagnostics.json`, `dom-diagnostics.json`) is **missing** from the
  archive. Remember these are optional in `REQUIRED_BUNDLE_FILES`; their absence
  is reduced evidence, not a corrupt bundle.
- An element fingerprint is too shallow to identify the element — no `data-*`
  attributes captured, no ancestry, text hashed when a structural label would do.
- The transaction trace stops without either a commit, an uncertain or a failure.
- Two sections disagree (e.g. `summary.txt` reports a state that
  `state-transitions.ndjson` does not contain).
- The failure is timing-dependent and the bundle has no `monotonicTime`-based
  measurement of the interval that mattered.

### What to add, in priority order

1. **More trace at the failure point**, not more trace everywhere. The signal is
   the first divergence, not the volume.
2. **Instrument the un-instrumented selector group.** A group with zero events is
   invisible. Every semantic group in both selector registries should be
   instrumented.
3. **Richer fingerprints** for the elements involved: capture the `data-*`
   attributes that identify an element, and enough ancestry to place it.
4. **Explicit start/end events for waiting**, so a stall has a measured interval
   rather than an inferred one.
5. **Durations on everything asynchronous.** A missing duration is a missing
   fact.
6. **A counter-event for every "nothing happened" case** — a wait that ended, a
   poll that found nothing, a timeout that fired. Silence is the hardest thing to
   diagnose.
7. **A section-coverage assertion** in `diag:selftest`, so a bundle missing an
   expected section fails loudly rather than producing a thin report.

### What *not* to add

- **More content.** Recording the message text, the resume, the chat history or
  the full HTML would make a bundle diagnosable and unsafe to share. Those are
  excluded by policy — see [`../diagnostics/PRIVACY.md`](../diagnostics/PRIVACY.md).
- **A second logger or a parallel path.** The recorder is the single sink;
  anything outside it bypasses write-time redaction.
- **A diagnosis in the analyzer where the evidence is thin.** A wrong `likely`
  costs more than an honest `unknown`.

### Recording the gap

Every insufficiency becomes, at minimum, an entry in the phase report:
what the failure was, which artefact was missing, and which of the additions
above would have answered it. A test that asserts the new evidence is present
should ship with the change.

---

## 14. Triage checklist

For any failure:

- [ ] Bundle verifies against `checksums.json`; a mismatch means re-export.
- [ ] `manifest.json` matches the build you think you tested.
- [ ] `summary.txt` read first; the primary failure identified.
- [ ] The **first divergence** found on the `sequence` axis, not the loudest
      error.
- [ ] The failure class matched to a section above.
- [ ] The right file opened first for that class.
- [ ] Evidence labelled `confirmed` / `likely` / `unknown`, honestly.
- [ ] If `unknown`: recorded as an insufficiency, not guessed at.
- [ ] The relevant invariant or gate reason identified by its real id.
- [ ] Reproduced with a minimal, sanitized fixture — or explicitly recorded as
      not reproducible.
- [ ] Root cause fixed, not the symptom.
- [ ] Regression test added.
- [ ] `pnpm check` passes.
- [ ] The same scenario re-run to a second consecutive pass.
- [ ] `pnpm diag:compare` shows the failure gone and no new failure introduced.
- [ ] The run directory contains the bundle and the notes.
