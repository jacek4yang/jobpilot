# JobPilot BOSS workflows

Behavioural specification for JobPilot's BOSS support. Each diagram is intended
to be implementable directly as a pure reducer: states are values, transitions
are triggered by events, and every transition names its precondition, success
condition, timeout, failure classification and recovery policy.

Companion documents:
`docs/product/boss-ux-spec.md` (presentation),
`docs/research/boss-reference-analysis.md` (source study and invariants).

---

## 0. Naming

| Term | Meaning |
|---|---|
| **Search profile** | A saved, named search intent (keywords, cities, filters) |
| **Discovery** | Applying a profile and collecting job cards |
| **Candidate** | A discovered job that has not yet been detail-evaluated |
| **Match** | A candidate that produced a score and a rule trace |
| **Queue item** | A match the user has selected for execution |
| **Communication** | The transactional act of sending one first message |
| **Intent** | The persisted record of an in-flight communication |

---

## 1. Top-level mode machine

JobPilot has exactly one **high-level mode**. Discovery and execution may never
run at the same time.

```
                  ┌──────────────────────────────────────┐
                  │                                      │
                  v                                      │
             ┌─────────┐   START_DISCOVERY          ┌────┴─────┐
   boot ────>│  IDLE   │───────────────────────────>│DISCOVERING│
             └────┬────┘                            └────┬─────┘
                  │                                      │
                  │ DISCOVERY_COMPLETE                   │ BLOCK_SIGNAL
                  v                                      v
             ┌──────────┐                          ┌───────────┐
             │REVIEWING │                          │  BLOCKED  │
             └────┬─────┘                          └─────┬─────┘
                  │                                      │
                  │ START_EXECUTION          RESUME (user)│
                  v                                      │
             ┌───────────┐                                 │
             │ EXECUTING │<────────────────────────────────┘
             └─────┬─────┘
                   │
                   │ PAUSE (user or safety)
                   v
             ┌───────────┐
             │  PAUSED   │──── RESUME ────> (previous mode restored)
             └───────────┘
```

**Invariant M1.** `START_DISCOVERY` while `EXECUTING` does not switch modes. It
raises a `MODE_CONFLICT` decision for the user: *pause the queue* or *cancel the
search*. Queue progress is never silently discarded.

**Invariant M2.** `BLOCKED` preserves the queue, the current item and the
communication intent. Nothing is cleared.

---

## 2. Per-job execution lifecycle

The unit of work is one queue item moving from `QUEUED` to a terminal state.

```
QUEUED
  │ take
  v
OPENING ──── timeout ────────────────────────────> FAILED(DETAIL_TIMEOUT)
  │ detail rendered
  v
DETAIL_READY
  │ validate (stage B rules)
  v
VALIDATING ── hard reject ──────────────────────> SKIPPED(FILTER_REJECTED)
  │ rules pass
  v
READY ────── no action affordance ──────────────> SKIPPED(ALREADY_CONTACTED | JOB_DISAPPEARED)
  │ arm intent, user/auto confirms
  v
COMMUNICATION_ARMED
  │ click communicate
  v
COMMUNICATION_STARTED ── risk/login ────────────> BLOCKED(RISK_CONTROL | LOGIN_REQUIRED)
  │
  ├── success modal ──> CHAT_WAIT
  └── unknown modal ──> BLOCKED(UNKNOWN_MODAL)
  │
  v
CHAT_WAIT ── timeout ───────────────────────────> FAILED(CHAT_MISMATCH)
  │ chat identity verified + stable
  v
CHAT_VERIFIED
  │
  ├── draft present ────────────────────────────> BLOCKED(DRAFT_PRESENT)
  │ editor empty
  v
MESSAGE_PREPARED
  │ editor content re-verified
  v
SEND_ATTEMPTED ───── (persisted before the click)
  │
  ├── outgoing delta observed ──────────────────> COMPLETED(contacted)
  ├── timeout / ambiguity ──────────────────────> UNCERTAIN
  └── chat changed mid-send ────────────────────> UNCERTAIN
```

### 2.1 Transition table

Every row is a unit-testable rule.

| From | Event | Precondition | Success condition | Timeout | On failure |
|---|---|---|---|---|---|
| `QUEUED` | `TAKE` | item is `queued`, mode is `EXECUTING` | item is `running` | — | — |
| `OPENING` | `DETAIL_RENDERED` | detail root belongs to this job id | identity verified | `detailWaitMs` | `FAILED(DETAIL_TIMEOUT)` |
| `OPENING` | `JOB_MISSING` | — | — | — | `SKIPPED(JOB_DISAPPEARED)` |
| `VALIDATING` | `RULES_EVALUATED` | stage-B rules ran | trace produced | — | `FAILED(DOM_CHANGED)` |
| `READY` | `ACTION_FOUND` | affordance inside active detail root | text classifies as communicate | — | `SKIPPED(ALREADY_CONTACTED)` |
| `COMMUNICATION_ARMED` | `ARM_INTENT` | no live intent for this job | intent persisted `armed` | — | `FAILED(DUPLICATE_INTENT)` |
| `COMMUNICATION_STARTED` | `CLICK` | element enabled, context verified | click dispatched | — | `FAILED(DOM_CHANGED)` |
| `COMMUNICATION_STARTED` | `MODAL` | modal classified | known success modal | `modalWaitMs` | `BLOCKED(UNKNOWN_MODAL)` |
| `CHAT_WAIT` | `CHAT_FOUND` | identity match **and** stable `chatStableMs` | chat verified | `chatWaitMs` | `FAILED(CHAT_MISMATCH)` |
| `CHAT_VERIFIED` | `DRAFT_CHECK` | editor readable | editor empty | — | `BLOCKED(DRAFT_PRESENT)` |
| `MESSAGE_PREPARED` | `EDITOR_VERIFIED` | editor equals intended text | match | — | `BLOCKED(USER_INTERRUPTED)` |
| `SEND_ATTEMPTED` | `SEND_CONFIRMED` | outgoing count > baseline | count increased | `sendWaitMs` | `UNCERTAIN` |

---

## 3. Communication transaction

This is the most safety-critical machine in the product. It is modelled as a
transaction with a persisted intent so that a reload can never cause a second
send.

### 3.1 Intent phases

```
        ┌────────┐
        │ armed  │  intent persisted, nothing clicked yet
        └───┬────┘
            │ communicate clicked
            v
     ┌──────────────┐
     │  navigating  │  SPA route change in flight
     └──────┬───────┘
            │ chat matched + stable
            v
   ┌────────────────┐
   │ chat-verified  │  identity confirmed, draft policy checked
   └───────┬────────┘
           │ message inserted, editor re-verified
           v
     ┌───────────┐
     │ prepared  │
     └─────┬─────┘
           │ *** persisted BEFORE clicking send ***
           v
  ┌─────────────────┐
  │ send-attempted  │  <-- the point of no return
  └────────┬────────┘
           │
     ┌─────┴──────┬─────────────┐
     │            │             │
     v            v             v
┌──────────┐ ┌──────────┐ ┌─────────┐
│ verified │ │ uncertain│ │ failed  │
└──────────┘ └──────────┘ └─────────┘
```

### 3.2 The send-attempted rule

> **Once an intent reaches `send-attempted`, no reload, timeout, retry or
> recovery path may click send again.**

The only legal action from `send-attempted` is **verification**:

1. Re-locate the conversation for this job id.
2. Count outgoing messages matching the intended text.
3. If the count exceeds the recorded baseline → `verified`.
4. If the count equals the baseline → **`uncertain`**, not `failed`. The click
   may have been lost, or the message may be rendered differently than expected.
5. `uncertain` requires human resolution. It is never auto-retried.

This rule is taken directly from the strongest idea in the reference
implementation, which persists `status: "sending"` before clicking and, on
reload in that state, only verifies.

### 3.3 Intent record

```ts
interface CommunicationIntent {
  id: string;                    // stable transaction id
  jobId: JobId;
  sourceUrl: string;             // where to return after success

  // Identity expectations, used to verify we are in the right conversation.
  expectedJobTitle?: string;
  expectedCompany?: string;
  expectedRecruiter?: string;

  phase:
    | "armed" | "navigating" | "chat-verified"
    | "prepared" | "send-attempted"
    | "verified" | "uncertain" | "failed";

  messageText: string;           // the exact text we intend to send
  outgoingBaseline: number;      // outgoing count observed before sending

  createdAt: number;
  expiresAt: number;
}
```

`messageText` and `outgoingBaseline` are recorded **before** the send purely so
that verification after a crash is possible. Without the baseline, "did my
message appear?" is unanswerable.

### 3.4 Expiry

An intent that expires while `armed`, `navigating`, `chat-verified` or
`prepared` is abandoned safely — the message was never sent. An intent that
expires while `send-attempted` becomes `uncertain`, never `failed`.

---

## 4. Chat identity verification

Sending into the wrong conversation is a privacy failure, not a bug. Identity is
verified with a strict precedence, and a bare editor is never sufficient.

```
                 ┌──────────────────────┐
                 │ candidate chat found │
                 └──────────┬───────────┘
                            v
              ┌──────────────────────────┐
              │ job id present in chat?  │
              └────┬────────────────┬────┘
                   │ yes            │ no
                   v                v
        ┌──────────────────┐  ┌───────────────────────┐
        │ ids intersect?   │  │ require title AND     │
        │  no  → MISMATCH  │  │ (company OR recruiter)│
        │  yes → verified  │  │  else → MISMATCH      │
        └──────────────────┘  └───────────────────────┘
                            │
                            v
              ┌──────────────────────────┐
              │ contradictory evidence?  │
              │  → MISMATCH (conservative)│
              └──────────┬───────────────┘
                         v
              ┌──────────────────────────┐
              │ stable for chatStableMs? │
              │  no → keep waiting       │
              └──────────┬───────────────┘
                         v
                    CHAT_VERIFIED
```

Text normalisation for comparison strips whitespace, `·•-—_()（）` and common
company suffixes (`股份有限公司`, `有限责任公司`, `有限公司`). This mirrors the
reference's `identityText` helper, which independently arrived at the same
normalisation.

**Invariant C1.** If the conversation changes during any step, the transaction
aborts to `uncertain` (if the send was already attempted) or `failed` (if not),
and the user's content is never modified.

---

## 5. Draft policy

```
             ┌──────────────────────────┐
             │ read editor content      │
             └───────────┬──────────────┘
                         v
              ┌──────────────────────┐
              │ non-empty?           │
              └───┬──────────────┬───┘
                  │ yes          │ no
                  v              v
     ┌────────────────────┐   ┌────────────────────┐
     │ BLOCKED            │   │ proceed: insert    │
     │ (DRAFT_PRESENT)    │   │ message, then      │
     │                    │   │ re-verify content  │
     │ never overwrite    │   └─────────┬──────────┘
     │ never send         │             v
     │ surface to user    │   ┌──────────────────────┐
     └────────────────────┘   │ changed since insert?│
                              │  yes → BLOCKED       │
                              │        (USER_INTERRUPTED)
                              └──────────────────────┘
```

The check runs **three times**: before claiming the item, immediately before
inserting, and immediately before clicking send. User content always wins.

---

## 6. Duplicate-send prevention

Five independent layers. Any one of them alone is sufficient to prevent a
duplicate; together they are defence in depth.

```
Layer 1  platform state      "继续沟通" / "已沟通" → treat as contacted
Layer 2  application history job id already has outcome contacted/verified
Layer 3  live intent         an active intent exists for this job id
Layer 4  outgoing message    the intended text already exists in the chat
Layer 5  queue dedup         job id cannot be enqueued twice
```

**Policy: prefer a false skip over a duplicate send.** If layer 1 or 4 is
ambiguous, skip and label the item `already contacted (assumed)` so the user can
override deliberately.

---

## 7. Risk and blocking

```
              ┌─────────────────────────────┐
              │ evaluate page safety signals│
              └──────────────┬──────────────┘
                             v
      ┌──────────┬───────────┼───────────┬──────────────┐
      v          v           v           v              v
  ┌────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐ ┌────────────┐
  │CAPTCHA │ │RISK    │ │ LOGIN   │ │ UNKNOWN  │ │ DOM_CHANGED│
  │        │ │CONTROL │ │REQUIRED │ │ MODAL    │ │            │
  └───┬────┘ └───┬────┘ └────┬────┘ └────┬─────┘ └─────┬──────┘
      └──────────┴───────────┴───────────┴─────────────┘
                             v
                    ┌─────────────────┐
                    │     BLOCKED     │
                    │                 │
                    │ stop all actions│
                    │ persist queue   │
                    │ persist intent  │
                    │ notify user     │
                    └────────┬────────┘
                             │ user resolves, chooses Resume
                             v
                    ┌─────────────────┐
                    │ verify page is  │
                    │ safe again      │
                    └────────┬────────┘
                       safe  │  not safe
                             v      └──> stay BLOCKED
                    resume prior mode
```

**JobPilot performs no action to resolve a verification page.** No dismissing,
no retrying through it, no alternate navigation.

---

## 8. Session recovery

```
        boot
          │
          v
  ┌───────────────────┐
  │ load persisted    │
  │ root + migrate    │
  └─────────┬─────────┘
            v
  ┌───────────────────┐
  │ live intent?      │
  └────┬─────────┬────┘
       │ no      │ yes
       v         v
  ┌─────────┐  ┌──────────────────────────────┐
  │ restore │  │ phase === "send-attempted"?  │
  │ queue   │  └───┬──────────────────────┬───┘
  │ safely  │      │ yes                  │ no
  └─────────┘      v                      v
            ┌──────────────┐      ┌──────────────────┐
            │ UNCERTAIN    │      │ abandon safely:  │
            │ verify only; │      │ nothing was sent │
            │ ask the user │      │ resume normally  │
            └──────────────┘      └──────────────────┘
```

Resuming never replays an irreversible action. The distinction between "safe to
resume" and "requires human decision" is the whole point of persisting the
intent.

---

## 9. Multi-tab ownership

```
   tab A                    storage                    tab B
     │                         │                         │
     │ request lock ──────────>│                         │
     │<─── acquired ───────────│                         │
     │                         │<──── request lock ──────│
     │                         │───── denied ───────────>│
     │                         │                         │
     │  (executes queue)       │      "running in another tab"
     │                         │      read-only status view
     │ periodic lease renew ──>│
     │                         │
     │  crash / close          │
     │  lease expires ────────>│<──── request lock ──────│
     │                         │───── acquired ─────────>│
```

- A `Lock` port abstracts `navigator.locks` so tests can substitute a fake.
- The owning tab renews a lease with a heartbeat; a stale lease is reclaimable.
- Taking over **never** replays an ambiguous send: the new owner re-reads the
  live intent and applies §8.
- A second tab still renders the panel in read-only mode, so the user is never
  left wondering whether JobPilot is running.

---

## 10. Manual interaction and yielding

Automation yields to the user rather than competing:

| User action | JobPilot response |
|---|---|
| Selects a different job | Pause; re-validate identity before continuing |
| Types into the message editor | `BLOCKED(DRAFT_PRESENT)` for that item |
| Changes BOSS search filters | Pause discovery; require restart |
| Navigates away | Observe route change; pause or reclassify page |
| Clicks a control JobPilot was about to click | Re-read state before acting |
| Opens an unrelated modal | Treat as `UNKNOWN_MODAL`; fail closed |

The reference implementation tracked a `scriptClick` flag to distinguish its own
clicks from the user's but did not consistently act on it. JobPilot makes
yielding an explicit, tested behaviour.

---

## 11. Failure taxonomy

Typed outcomes, used identically in the state machine, history, logs, UI and
tests.

| Code | Meaning | Retryable |
|---|---|---|
| `DOM_CHANGED` | Expected structure absent or altered | sometimes, after re-locating |
| `JOB_DISAPPEARED` | Listing no longer contains the job | no |
| `ALREADY_CONTACTED` | Platform or history says contacted | no |
| `FILTER_REJECTED` | A hard rule rejected it | no |
| `DETAIL_TIMEOUT` | Detail did not render in time | yes, bounded |
| `CHAT_MISMATCH` | Conversation identity unconfirmed | yes, bounded |
| `DRAFT_PRESENT` | User text in the editor | **no — user action required** |
| `SEND_UNCERTAIN` | Send attempted, outcome unobservable | **no — user action required** |
| `RISK_CONTROL` | Risk-control page | **no — user action required** |
| `LOGIN_REQUIRED` | Session expired | **no — user action required** |
| `UNKNOWN_MODAL` | Unrecognised dialog | **no** |
| `USER_INTERRUPTED` | User took control | no |
| `RATE_LIMIT_REACHED` | Hourly/day cap | yes, after the window |
| `DAILY_LIMIT_REACHED` | Daily cap | yes, next day |

The three bolded rows are the ones that must never be auto-retried.

---

## 12. Discover → evaluate → queue pipeline

```
  profile
     │
     v
┌─────────────┐   verify resulting filter state (else abort)
│ apply search│──────────────────────────────────────────────┐
└──────┬──────┘                                              │
       v                                                     │
┌─────────────┐   incrementally, debounced                   │
│ parse cards │                                              │
└──────┬──────┘                                              │
       v                                                     │
┌─────────────────────┐                                      │
│ STAGE A: cheap      │  duplicate · blacklist · title       │
│ (card only)         │  exclude · location · salary         │
└──────┬──────────────┘                                      │
       │ survivors                                           │
       v                                                     │
┌─────────────────────┐                                      │
│ STAGE B: detail     │  open only survivors                 │
│ (detail required)   │  JD · skills · activity · attributes │
└──────┬──────────────┘                                      │
       v                                                     │
┌─────────────┐                                              │
│ score +     │  every match carries an ordered rule trace    │
│ explain     │                                              │
└──────┬──────┘                                              │
       v                                                     │
┌─────────────┐                                              │
│ human review│  <-- mandatory. No auto-queue from discovery │
└──────┬──────┘                                              │
       v                                                     │
┌─────────────┐                                              │
│ queue       │                                              │
└─────────────┘                                              │
```

**Invariant P1.** Discovery never enqueues directly. The user always passes
through Matches. Even in `Automatic` mode, the queue is built from an explicit
selection (which may be "select all accepted").

---

## 13. Limit enforcement

Limits are checked at the moment of arming an intent, not at click time, so a
send can never slip through a cap.

```
        arm intent
             │
             v
   ┌──────────────────────┐
   │ per-run cap reached? │──yes──> BLOCKED(LIMIT) + prompt
   └──────────┬───────────┘
              │ no
              v
   ┌──────────────────────┐
   │ per-hour cap?        │──yes──> wait until window frees, or stop
   └──────────┬───────────┘
              │ no
              v
   ┌──────────────────────┐
   │ per-day cap?         │──yes──> DAILY_LIMIT_REACHED, stop for today
   └──────────┬───────────┘
              │ no
              v
   ┌──────────────────────┐
   │ consecutive failures │──yes──> stop (protects against a broken DOM)
   │ ≥ threshold?         │
   └──────────┬───────────┘
              │ no
              v
           proceed
```
