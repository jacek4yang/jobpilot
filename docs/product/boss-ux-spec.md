# JobPilot BOSS UX specification

Scope: the user-facing design for JobPilot's BOSS Zhipin support. This document
describes *what the product is*, not how it is built. Behavioural state machines
live in `docs/product/boss-workflows.md`.

Design stance: JobPilot is a **job-search assistant that happens to automate**,
not a bot console. The user must always be able to answer four questions without
reading logs:

1. What is JobPilot doing right now?
2. Why did it choose this job?
3. What will it do next?
4. How do I make it stop?

Every decision below is subordinate to the safety invariants in
`docs/research/boss-reference-analysis.md` §2.1. When UX polish and safety
conflict, safety wins.

---

## 1. Design principles

| # | Principle | Consequence |
|---|---|---|
| 1 | Safety over throughput | No control exists that trades duplicate-send risk for speed |
| 2 | Explainability | Every accept/reject shows its reasons inline, never a bare score |
| 3 | Reversibility | Nothing irreversible happens without either confirmation or Review mode |
| 4 | Visibility | Current job, current phase and queue position are always on screen |
| 5 | Yielding | Any user action takes precedence; automation pauses rather than competes |
| 6 | Progressive disclosure | Common actions one click away; timeouts and selectors under Advanced |
| 7 | Honest status | "Uncertain" is a real, displayed state — never rounded to success |
| 8 | Non-intrusion | Host page keeps its layout; panel is small, movable and collapsible |

---

## 2. Information architecture

```
Launcher (always present, ~40px)
└── Shell
    ├── Status header      mode · safety indicator · active-profile summary
    ├── Search             search profiles, run discovery
    ├── Matches            discovered jobs, selection, reasons
    ├── Queue              execution queue and per-item control
    ├── History            processed jobs, outcomes, export
    ├── Rules              hard filters, scoring weights, live preview
    ├── Messages           message templates and rendering preview
    ├── Settings           general / automation / limits / advanced
    └── Logs               friendly activity feed + Diagnostics disclosure
```

Tabs are ordered by workflow, not by implementation: the user moves left to
right as they progress from intent to outcome.

### 2.1 Why these groupings

- **Search** and **Matches** are separate because discovery and judgement are
  different mental acts. Merging them invites blind execution.
- **Matches** sits between discovery and execution deliberately: the brief
  forbids a straight line from search to sending.
- **Rules** is separate from **Settings** because rules are domain content the
  user edits often, while settings are configuration they touch rarely.
- **Messages** is separate from **Settings** for the same reason.
- **Logs** holds both a human feed and a technical disclosure; normal users
  never need the latter.

---

## 3. Panel layout

### 3.1 Collapsed launcher

```
┌──────────────┐
│ JP  ● 12/40  │
└──────────────┘
```

- `JP` monogram; clicking expands.
- Status dot: grey idle, blue running, amber paused, red blocked.
- Counter shows `contacted / target` when a profile run is active, else the
  queue depth.
- Draggable; position persisted. Never auto-expands.

### 3.2 Expanded panel

```
┌─────────────────────────────────────────┐
│ JobPilot              Assist · ● Safe ▾ │  header: mode + safety
│ Search Matches Queue History Rules …    │  tab strip
├─────────────────────────────────────────┤
│ Backend Engineer · Example Corp         │  current item
│ Score 84  ▸ why                         │
│ ████████░░░░░░░░  phase: verifying      │  phase bar
├─────────────────────────────────────────┤
│ Found 126   Matched 38   Queued 21      │  stat row
│ Contacted 7 Skipped 12   Failed 0       │
├─────────────────────────────────────────┤
│ [Pause] [Skip current] [Stop]           │  controls
└─────────────────────────────────────────┘
```

Header always shows the **mode** and a **safety indicator**. The safety
indicator is a single word with a tooltip:

| Indicator | Meaning |
|---|---|
| `Safe` | Review/Assist; nothing irreversible will happen unattended |
| `Auto` | Automatic mode armed (amber) |
| `Paused` | Halted by user |
| `Blocked` | Halted by a safety signal (red) — reason shown inline |

### 3.3 Styling

- Shadow DOM root so BOSS styles cannot leak in and JobPilot styles cannot leak
  out. If Shadow DOM proves unreliable on the host page, fall back to a scoped
  `jobpilot-` prefix on every rule plus `all: initial` on the root.
- Neutral palette, one accent. The reference panels use a teal accent; JobPilot
  uses a restrained blue-grey so it reads as a tool, not an alert.
- No animation beyond opacity/height transitions on the tab strip and toasts.
- Density: 12px base, 1.5 line-height, tabular numerals for counters.
- Focus-visible outlines on every interactive element.

---

## 4. Search workflow

### 4.1 Search profiles

A **search profile** is a named, reusable search intent. Users typically keep
several (`Rust Backend`, `Security Research`, `C++ Infrastructure`,
`Graduate Jobs`, `Internships`).

```
┌ Search ─────────────────────────────────┐
│ [Rust Backend          ▾] [+ New] [⋯]   │  profile picker
│                                         │
│ Keywords   Rust, 后端, 分布式            │
│ Cities     北京, 上海, 杭州              │
│ Salary     ≥ 25K                        │
│ Experience 3-5年, 5-10年                 │
│ Degree     本科, 硕士                    │
│ Scale      100-499人, 500-999人          │
│ Activity   Active today                 │
│                                         │
│ Include    rust, tokio, kafka           │
│ Exclude    外包, 销售, 猎头              │
│                                         │
│ [Run discovery]      [Edit profile]     │
└─────────────────────────────────────────┘
```

Profile operations: create, duplicate, rename, edit, delete, export, import.
Deleting requires confirmation. Editing an active profile does not mutate a
running discovery pass.

### 4.2 Running discovery

When discovery starts:

1. The panel states the profile being applied in plain language.
2. JobPilot determines the **current** filter state on the BOSS page.
3. It applies the **minimum** change needed, then **re-reads and verifies** the
   resulting state. If verification fails, discovery stops with a clear reason.
4. Results stabilise before parsing begins.
5. Progress is shown as `Found N` incrementing, with a live count.

If the profile names a city that does not resolve, discovery **does not start**.
The panel shows:

```
City "楚雄" is not a recognised BOSS city.
Did you mean: 楚雄彝族自治州?
[Fix profile]
```

> Rationale: silently searching a default city would waste the user's run and
> could contact the wrong region. See `city-resolver.ts`.

### 4.3 Two-stage evaluation, surfaced

The user is told *when* work happens:

- **Stage A (cheap)** runs during parsing: duplicates, blacklists, obvious
  excludes, location, reliable salary. Jobs failing here appear in Matches as
  rejected with a reason and are never opened.
- **Stage B (detail)** runs only for survivors, and the panel shows
  `Opening 3 of 21 …`. This makes the cost of a broad profile legible.

---

## 5. Match review

The central judgement surface. Automation never runs from here without an
explicit mode change.

```
┌ Matches ────────────────────────────────┐
│ Accepted 38      [Select all] [None]    │
│ Sort: score ▾   Filter: accepted ▾      │
├─────────────────────────────────────────┤
│ [✓] 86  Backend Engineer   Company A    │
│         20-35K · 北京 · BOSS active 2h  │
│         +20 Rust  +15 distributed …     │
│ [✓] 81  Rust Developer     Company B    │
│ [ ] 63  Software Engineer  Company C    │
│ [✗] —   Sales Manager      Company D    │
│         Rejected: excluded keyword 销售 │
└─────────────────────────────────────────┘
```

Per-row actions: open original posting, inspect full reasons, exclude this job,
exclude this company, add to queue, remove from queue.

Row states are visually distinct: accepted (default), rejected (muted, struck
score), already contacted (badge), uncertain (amber badge).

**Reasons are always one click away and never truncated to a number.**
Expanding a row shows the full ordered rule trace, e.g.:

```
Score 86  (threshold 65)

+ 20  skill "Rust" in description
+ 15  keyword "distributed systems" in description
+ 10  recruiter active today
+ 10  salary 20-35K above target 15K
+  5  company scale 100-499 matches preference
-  4  degree requires 硕士, preference is 本科

No hard filter rejected this job.
```

---

## 6. Queue UX

The queue is a visible, inspectable list — not an invisible loop.

### 6.1 Queue item

```
┌ Queue ──────────────────────────────────┐
│ ▶ running  86  Backend Engineer         │
│            Company A · attempt 1        │
│            phase: verifying send        │
│            [Skip] [Stop after this]     │
├─────────────────────────────────────────┤
│    queued   81  Rust Developer          │
│              Company B                  │
│              [Remove]                   │
│    queued   78  Platform Engineer       │
│    done     74  Systems Engineer   ✓    │
│    skipped  63  Software Engineer  —    │
│              already contacted          │
│    blocked  —   Data Engineer      ⚠    │
│              draft present in chat      │
└─────────────────────────────────────────┘
```

Statuses shown: `queued · opening · validating · ready · communicating ·
waiting-chat · sending-message · verifying · completed · skipped · failed ·
blocked · cancelled`.

### 6.2 Queue controls

| Control | Behaviour |
|---|---|
| Pause | Stops after the current *atomic* step; never mid-send |
| Resume | Continues from the persisted phase |
| Skip current | Cancels the current item safely; refuses to interrupt a send already attempted |
| Stop after this | Finishes the current item, then halts |
| Remove | Only for `queued` items |
| Retry | Offered only for failures classified as safely retryable |
| Clear completed | Housekeeping; never touches `uncertain` items |

### 6.3 The rule that governs the queue

**An item whose send outcome is `uncertain` cannot be retried, skipped or
auto-cleared.** It sits in the queue with a distinct badge until the user
inspects the conversation and resolves it. This is the single most important
queue behaviour.

---

## 7. Communication workflow (user-visible)

The user sees a linear narrative, not a state machine:

```
Opening Backend Engineer at Example Corp…
Checking the posting matches your rules…
Found the contact button.
Opening the chat…
Confirming this is the right conversation…
Preparing your message…
Sending…
Confirming the message was sent…
Done — 7 contacted today.
```

Every step is announced **before** it is attempted, so the panel is never lying
about the present.

### 7.1 The three mode gates

| Mode | Discovery | Opening jobs | Communication |
|---|---|---|---|
| **Review** | yes | no | never |
| **Assist** | yes | yes | pauses for confirmation before the first send |
| **Automatic** | yes | yes | sends unattended once armed |

`Assist` is the default. Switching to `Automatic` requires an explicit
confirmation dialog that names the risk; it is required **once per arming**, not
per job.

### 7.2 Draft protection as a visible event

If the conversation already contains text the user typed:

```
⚠ Draft detected in this conversation.
JobPilot has not touched it and will not send.

[Skip this job]  [Open conversation]
```

The queue item moves to `blocked` with reason `DRAFT_PRESENT`. Automation does
not resume on that item automatically.

### 7.3 Uncertain outcome as a first-class state

If JobPilot clicked send but could not observe the message:

```
⚠ Could not confirm the message was sent.
This job will NOT be retried automatically.

[Open conversation to check]  [Mark as sent]  [Mark as not sent]
```

Selecting either manual resolution is recorded in history with
`outcome: "contacted"` or `"uncertain"` and the user's decision noted.

---

## 8. Error and blocked states

Blocked states replace the normal panel body with a focused explanation. The
user is never left guessing why automation stopped.

```
┌ Blocked ────────────────────────────────┐
│ ⛔ Security verification detected        │
│                                         │
│ BOSS is showing a verification page.    │
│ JobPilot has stopped all actions.       │
│ Your queue and progress are saved.      │
│                                         │
│ Complete the verification in the page,  │
│ then choose Resume.                     │
│                                         │
│ [Open the page]  [Resume]  [Stop]       │
└─────────────────────────────────────────┘
```

Blocked reasons, each with its own plain-language text: `CAPTCHA`,
`RISK_CONTROL`, `LOGIN_REQUIRED`, `UNKNOWN_MODAL`, `DOM_CHANGED`,
`CHAT_MISMATCH`, `SEND_UNCERTAIN`, `RATE_LIMIT_REACHED`, `DAILY_LIMIT_REACHED`.

**JobPilot never attempts to dismiss, solve or bypass a verification page.**

---

## 9. Recovery UX

### 9.1 After a refresh or navigation

JobPilot restores the queue and states what happened, honestly:

| Persisted state | Message |
|---|---|
| Idle / paused | "Restored 21 queued jobs." → `[Resume]` |
| Mid-open (harmless) | "Resuming from job 4 of 21." |
| Send attempted, unconfirmed | "A message may have been sent to Example Corp. Please check." → must be resolved |
| Blocked | Blocked panel, as §8 |

### 9.2 Multi-tab

Only one tab owns execution:

```
JobPilot is running in another tab.
This tab is read-only.   [Take over]
```

`Take over` requests the lock; it only succeeds if the owning tab has released
it or its lease expired. Taking over never replays an ambiguous send.

---

## 10. First-run UX

A single dismissible card, five lines, no carousel:

```
Welcome to JobPilot

1. JobPilot runs locally in your BOSS tab.
2. Start in Review or Assist mode.
3. Create a search profile to begin.
4. JobPilot never bypasses CAPTCHA or security checks.
5. Automatic sending must be enabled explicitly.

[Create your first profile]  [Skip]
```

---

## 11. Settings hierarchy

```
Settings
├── General        language, panel position, onboarding reset
├── Automation     mode, first-message source, draft policy, confirmations
├── Limits         per run / per hour / per day, interval range, failure stop
├── Rules ▸        (links to the Rules tab)
├── Messages ▸     (links to the Messages tab)
└── Advanced ▸
    ├── timeouts            detail / chat / phrase / send / modal
    ├── stability windows   chat stable, phrase stable
    ├── diagnostics         capture level, export
    └── import              import BOSS Helper settings
```

Advanced holds every timeout. Defaults are sane; most users never open it.

### 11.1 Import from BOSS Helper

If legacy keys are detected, a **non-destructive, opt-in** prompt appears:

```
Found BOSS Helper settings on this device.
Import keywords, limits and activity preference?
Transient run state will not be imported.

[Review]  [Import]  [Not now]
```

`Review` shows a field-by-field diff before anything is written. Nothing is
migrated silently.

---

## 12. Keyboard interaction

Active only when the panel has focus, and never while the host page holds focus
in an `input`, `textarea` or `contenteditable`:

| Key | Action |
|---|---|
| `P` | Pause / resume |
| `S` | Skip current item |
| `Esc` | Collapse panel |
| `?` | Shortcut help |

Global page shortcuts are explicitly not registered.

---

## 13. Accessibility and legibility

- All controls are real `<button>`/`<input>` elements, keyboard reachable.
- Status is conveyed by text as well as colour.
- Counters use tabular numerals to avoid layout jitter.
- The panel is usable at 1280×720 and at 200% zoom.
- Blocked panels put the reason first, in plain language, in the largest text on
  screen.

---

## 14. What the UI deliberately does not do

- No persistent modal dialogs over the host page.
- No toast spam: at most one toast at a time, auto-dismissing.
- No raw log output in the main flow.
- No selector or timeout fields outside Advanced.
- No "run everything visible" button.
- No score without reasons.
- No success message that is not backed by observed evidence.
