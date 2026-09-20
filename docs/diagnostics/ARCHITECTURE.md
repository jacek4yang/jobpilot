# JobPilot diagnostics architecture

Design document for the pre-production hardening phase. Written before
implementation, per the phase brief.

The goal is a closed loop:

```
observe everything important
    -> reproduce
    -> export complete evidence
    -> analyse offline
    -> fix one class of failure
    -> add a regression test
    -> repeat
```

The governing principle:

> If a real-site failure cannot be reconstructed from the exported bundle, the
> diagnostics are not good enough.

---

## 1. What already exists (and is not duplicated)

| Concern | Existing module | Reused? |
|---|---|---|
| Structured logger + redaction | `src/ports/logger.ts`, `src/infrastructure/logging/logger.ts` | Yes — extended, not replaced |
| State machine | `src/application/state.ts`, `reducer.ts` | Yes — wrapped with tracing |
| Effects | `src/application/events.ts`, `orchestrator.ts` | Yes — traced at the dispatch boundary |
| Queue | `src/infrastructure/queue/queue.ts` | Yes — traced via a decorator |
| Communication transaction | `src/domain/communication/intent.ts`, `application/communication-runner.ts` | Yes — traced plus new assertions |
| Selector registry | `src/adapters/boss/selectors.ts`, `communication/selectors.ts` | Yes — instrumented, not forked |
| Cross-tab lock | `src/ports/lock.ts`, `adapters/userscript/navigator-lock.ts` | Yes — traced via decorator |
| Storage | `src/ports/storage.ts`, `application/repository.ts` | Yes — traced via decorator |
| BOSS diagnostics | `src/adapters/boss/diagnostics/boss-diagnostics.ts` | Yes — fed into the bundle as one section |
| Panel | `src/ui/panel.ts`, `sections.ts`, `view-model.ts` | Yes — one diagnostic-only tab added |
| Build | `vite.config.ts`, `scripts/verify-build.ts` | Yes — parameterised by channel |

There is no second logging system, no second state machine and no parallel
storage layer. Everything below is additive and sits behind ports.

---

## 2. Minimum architectural change

Three new concepts, each with a narrow responsibility:

1. **A diagnostic recorder** (`src/diagnostics/recorder.ts`) — an append-only,
   bounded, sequence-numbered event stream. It is the single sink every other
   subsystem writes to. It implements the existing `Logger` port, so existing
   call sites gain structured recording without being rewritten.

2. **Decorators at existing boundaries** — the recorder observes the queue, the
   lock, storage and the selector registry from the outside. None of those
   modules learn about diagnostics, so the domain stays pure and the decorators
   are unit-testable with fakes.

3. **Channel selection at the composition root** — `bootstrap` receives a
   `BuildInfo` and a recorder configured for that channel. The production
   channel keeps the existing bounded ring buffer; the diagnostic channel gets
   larger buffers, `trace`-level events and bundle export.

Nothing in `domain/` gains a diagnostics dependency. The recorder is injected at
the same boundaries as `Logger` already is.

---

## 3. Build channels

```
pnpm build              -> dist/jobpilot.user.js
pnpm build:diagnostic   -> dist/jobpilot.diagnostic.user.js
```

Both are standalone userscripts with no CDN runtime dependency. The diagnostic
build differs only in:

| Aspect | production | diagnostic |
|---|---|---|
| `__JOBPILOT_CHANNEL__` | `"production"` | `"diagnostic"` |
| minify | yes | yes (kept small; readable via sourcemap-free structured events) |
| event buffer | 500 | 20 000 |
| `trace` level | discarded | recorded |
| bundle export | menu command, minimal | full support bundle |
| diagnostics tab | hidden | shown |

**Safety behaviour is identical in both channels.** The brief is explicit:
diagnostic mode observes more, it does not behave less safely. This is enforced
by a test asserting that channel selection does not alter any guard, timeout or
mode default.

`BuildInfo` is generated at build time:

```ts
interface BuildInfo {
  appVersion: string;
  gitCommit: string;      // "unknown" when git is unavailable, never faked
  buildTimestamp: string;
  channel: "production" | "diagnostic";
  schemaVersion: number;
  diagnosticSchemaVersion: number;
}
```

`gitCommit` is read from `git rev-parse HEAD` at build time and falls back to
the literal string `"unknown"`.

---

## 4. Diagnostic session

```ts
interface DiagnosticSession {
  id: string;
  scenarioId: string;
  scenarioName: string;
  startedAt: number;
  finishedAt?: number;
  build: BuildInfo;
  status: "running" | "completed" | "failed" | "blocked" | "aborted";
  operatorNotes?: string;
}
```

The session id is stamped onto every event, transition, queue snapshot, DOM
diagnostic and bundle filename. Timestamps are never the join key — `sequence`
is, and `sessionId` scopes it.

A session is started explicitly by the operator, not on page load. Without a
session the recorder still runs (so a crash before starting is still captured)
under a synthetic `pre-session` id.

---

## 5. Event model

```ts
interface DiagnosticEvent {
  sequence: number;        // monotonic within a session
  sessionId: string;
  wallTime: number;        // Date.now()
  monotonicTime: number;   // performance.now() — survives clock changes
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  category: string;
  event: string;           // stable, machine-readable, dot.namespaced
  state?: string;
  jobId?: string;
  queueItemId?: string;
  transactionId?: string;
  routeId?: string;
  data?: Record<string, JsonValue>;
}
```

`monotonicTime` exists specifically to reconstruct races: wall-clock time can
jump, `performance.now()` cannot.

### Categories

`runtime, bootstrap, route, page-detection, selector, dom, discovery, parser,
filter, scoring, queue, state-machine, effect, communication, chat-identity,
message, verification, storage, migration, lock, rate-limit, retry, watchdog,
observer, user-action, risk, error, recovery`

### Event names

Machine-readable and stable. Examples:

```
queue.item.enqueued          state.transition
queue.item.started           state.transition.rejected
queue.item.skipped           selector.match
route.changed                selector.miss
storage.read.failed          selector.ambiguous
communication.intent.created communication.send.attempted
communication.send.verified  communication.send.uncertain
chat.identity.matched        chat.identity.rejected
risk.captcha.detected        risk.security_verification.detected
effect.open_job.started      effect.verify_send.failed
```

Human-readable strings are rendered for the UI only; analysis reads `event`.

---

## 6. State, effect and transaction tracing

**State transitions.** Wrapping `reduce` records `from`, `trigger`, `to`, the
generated effect types, the dwell time in `from`, and the correlation ids.
Rejected or ignored transitions are recorded too (the reducer returns the
context unchanged for illegal events; that "nothing happened" is diagnostically
important).

**Effects.** Four points per effect: `started`, `completed`, `failed`,
`timed_out`, each with a duration. The brief's rule is respected: for anything
irreversible the *intent* is recorded before the action, never after.

**Communication.** The transaction already has a stable id and an explicit
phase machine, so tracing is a matter of recording each phase edge plus the
identity evidence. The full ordered trace is:

```
intent.created -> action.discovered -> preconditions.checked -> intent.armed
-> navigation.started -> modal.observed -> chat.candidate.detected
-> identity.evaluated -> chat.verified -> message.source.selected
-> editor.inspected -> draft.check.completed -> message.prepared
-> send.attempt.persisted -> send.clicked -> verification.started
-> outgoing_message.found -> transaction.committed
   or -> transaction.uncertain
```

Once `communication.send.attempted` is persisted, resend is forbidden until the
system positively determines no send occurred. If it cannot, the outcome is
`SEND_UNCERTAIN`. This is already the domain rule; the diagnostics record the
evidence that justified whichever branch was taken.

---

## 7. Privacy model

Redaction happens **at write time**, in the recorder, not at export time. A
value that never enters the buffer cannot leak through a new export path.

Never recorded: cookies, authorization headers, tokens, session ids, passwords,
resume text, chat history, recruiter messages, user drafts, full message bodies,
complete page HTML.

For an outgoing message JobPilot generated, only:

```
templateId, messageLength, messageSha256, variablesUsed
```

`redact()` from the existing logger is reused and extended. Text in DOM
diagnostics is normalised, truncated and/or hashed.

A privacy test seeds fake secrets into every likely sink, generates a bundle and
asserts none appear anywhere in the ZIP. That test is a CI gate.

---

## 8. DOM and selector diagnostics

Full HTML is never exported. Instead, a bounded semantic record:

```ts
interface DomTargetDiagnostic {
  purpose: string;
  route: string;
  selectorCandidates: SelectorAttempt[];
  matchedCount: number;
  selectedElement?: ElementFingerprint;
  ancestry?: ElementFingerprint[];
  nearby?: ElementFingerprint[];
  capturedAt: number;
}
```

An `ElementFingerprint` carries tag, id, classes, role, aria-label, selected
`data-*` attributes, a text fingerprint (hashed or truncated) and a rect.

Selector instrumentation records, per candidate: the selector, its declared
confidence, match count, visible match count, context-validation result, and the
accept/reject reason. This is the single most valuable artefact when BOSS changes
markup, so it is implemented for every semantic group in both selector
registries.

A separate **page fingerprint** summarises route pattern, page kind, presence of
key regions, job-card count, dialog count, stable markers and structural
signatures — enough to answer "is this a new layout?" without hashing the page.

---

## 9. Storage health and `DEGRADED_READ_ONLY`

Storage failure must not be silent. A `StorageHealth` value is derived from
observed read/write outcomes and surfaced to the UI and to the execution gates.

When persistence is unhealthy:

```
enter DEGRADED_READ_ONLY
  -> pause automatic execution
  -> refuse new irreversible actions
  -> keep read-only inspection working
  -> show a persistent warning with Export / Retry / Reset
```

Reset requires explicit confirmation. Automatic sends never continue without
reliable persistence, because duplicate-prevention state could not be recorded.

This is enforced as an execution gate consulted at the same point as the lock and
the mode, and it is one of the production invariants covered by tests.

---

## 10. Human verification

New blocked state: `BLOCKED_HUMAN_VERIFICATION`, reachable from CAPTCHA,
security verification, identity verification, login-required and
operation-too-frequent detection.

On entry: stop JobPilot actions immediately, cancel pending safe effects, **do
not** cancel persisted communication evidence, do not touch verification
widgets. The panel shrinks out of the way.

Recovery is strictly two-step, and never automatic:

```
user completes the challenge in the BOSS UI
  -> user presses "Re-check page"
       -> JobPilot validates: login valid, risk UI gone, route sane,
          transaction state safe, persistence healthy, queue ownership valid
  -> shows "Ready to resume"
  -> user explicitly presses Resume
```

The challenge disappearing is never sufficient to resume. An ambiguous
`send-attempted` transaction is never resumed by resending.

---

## 11. Cross-tab, user actions, crash capture

**Lock.** `lock.requested / acquired / rejected / renewed / released /
lease_expired / ownership_changed` with `tabId`, `ownerId`, `leaseId`. The UI
shows the execution owner.

**User actions.** High-level only: `user.start`, `user.pause`, `user.resume`,
`user.stop`, `user.skip`, `user.retry`, `user.mode_changed`,
`user.opened_job`, `user.changed_route`, `user.edited_message`,
`user.completed_verification`. No keylogging, no arbitrary click recording.

**Crash capture.** `uncaught errors`, `unhandled rejections`, watchdog
failures and invariant violations, classified by whether the stack belongs to
JobPilot so unrelated BOSS site errors are not misattributed.

---

## 12. Bounded memory

Ring buffers for events, snapshots, DOM diagnostics, errors, transitions and
queue snapshots. On eviction, emit `diagnostics.buffer.truncated` with counts.

Critical transaction events are retained in a **separate** small buffer so that
a flood of trace noise cannot evict the evidence for a send.

---

## 13. Support bundle

A ZIP built entirely in-page. Structure:

```
jobpilot-diagnostic/
├── manifest.json          format version, build, session, files, checksums
├── summary.txt            the primary failure, without reading the event log
├── build.json
├── environment.json
├── session.json
├── events.ndjson
├── state-transitions.ndjson
├── queue.json
├── transactions.json
├── selector-diagnostics.json
├── dom-diagnostics.json
├── storage-summary.json
├── errors.json
├── config.redacted.json
├── checksums.json
└── README.txt
```

`summary.txt` is the entry point: version, commit, scenario, session, final
status and state, route, current job, queue counts, transaction status, fatal
error, first important failure, whether human verification was hit, storage
health, lock owner, event and snapshot counts.

**ZIP implementation.** A minimal, self-contained store-only (no compression)
ZIP writer lives in `src/diagnostics/bundle/zip.ts`. Rationale: the requirement
is a handful of small text files; a full compression library would add tens of
kilobytes to a userscript for no benefit, and CRC-32 plus a local/central
directory is a small, fully testable function. Store-only keeps CPU negligible
during a live test. Sizes are reported in the manifest so the operator can see
if a bundle grows unexpectedly.

**Destination.** Two paths:

- *Preferred*: the user picks a directory via the File System Access API
  (`showDirectoryPicker`) and the bundle is written to
  `JobPilot-Diagnostics/<date>/<scenario>/`. Permission is requested explicitly
  and revocation is handled gracefully.
- *Fallback*: a normal browser download with a deterministic filename:
  `jobpilot-diag_<scenario>_<session>_<timestamp>_<version>_<commit>.zip`.

The filename is always shown so the operator can file it manually. JobPilot
never claims filesystem access it does not have, and never writes outside the
user-granted root.

---

## 14. Offline analyzer

```
pnpm diag:analyze <bundle.zip>
pnpm diag:compare <a.zip> <b.zip>
pnpm diag:selftest
```

`analyze` validates the schema, verifies checksums, then reconstructs the event
timeline, state transitions, queue lifecycle, and each communication
transaction, and summarises selector misses, timeouts, retries, route changes,
storage problems and lock problems. It identifies the first divergence and any
invariant violation.

Output:

```
diagnostic-analysis/<session-id>/
├── report.md
├── timeline.md
├── selector-report.md
├── transaction-report.md
└── machine-summary.json
```

It flags patterns where the evidence is deterministic enough to do so, and
labels every finding `confirmed`, `likely` or `unknown` with evidence
references. It does not invent a diagnosis when evidence is thin.

`compare` answers the iteration questions: did the selector failure disappear,
did the workflow progress further, did a new failure appear, did timing regress.

---

## 15. Invariants

Encoded as assertions with tests. A violation logs `INVARIANT_VIOLATION` and
fails closed.

```
No send without persisted intent.
No send without verified target chat.
No send while storage is unhealthy.
No send while queue ownership is absent.
No send when an existing draft is present.
No second send after SEND_ATTEMPTED unless the previous outcome
  is conclusively proven not to have occurred.
No automatic action during human verification.
No continuation through an unknown blocking modal.
No automatic send after ambiguous reload recovery.
No second tab executing the same queue.
```

They are enforced at the arm point (where an intent is created) rather than at
the click, so a send cannot slip past a gate that closes mid-flight.

---

## 16. Queue to runner integration

The one structural gap: `orchestrator.ts` never calls
`communicationRunner.run()`, so no message is sent end to end. This phase
connects it, behind every existing gate — mode, storage health, lock ownership,
rate limits, human-verification state, transaction checks and chat identity.

The integration is a new effect (`communicate-job`) handled by the orchestrator,
which resolves the intent, checks the gates in a fixed order, and delegates to
the runner. Gate order is asserted by test, because a gate that runs after the
irreversible step is not a gate.

---

## 17. Documentation deliverables

```
docs/diagnostics/ARCHITECTURE.md   (this file)
docs/diagnostics/BUNDLE_FORMAT.md
docs/diagnostics/PRIVACY.md
docs/live-testing/RUNBOOK.md
docs/live-testing/TEST_MATRIX.md
docs/live-testing/FAILURE_TRIAGE.md
```

---

## 18. Definition of ready

Tracked in `docs/live-testing/TEST_MATRIX.md` and reported at the end of the
phase. The phase is complete when the observation, evidence-export,
offline-analysis, regression and human-verification workflows all work and all
local gates pass — not when a live site has been verified. No live BOSS
communication is performed during this phase.
