# Production path and ownership map

This map describes the shipped userscript composition. It is an implementation
reference, not a product promise. Update it whenever an owner or irreversible
boundary moves.

| Step | Entry and owner | State / persistence | Cancellation, failure, recovery | Production-path evidence |
| --- | --- | --- | --- | --- |
| Boot | `src/index.ts` → `bootstrap()` | GM root is loaded through traced storage; unreadable storage enters read-only mode | Bootstrap retains a usable panel and diagnostic recorder; automation gates remain closed | bootstrap/browser composition tests |
| Page detection | BOSS adapter `detectPage` plus detailed classifier | Current classification is held by bootstrap | CAPTCHA, risk and login dominate; unknown fails closed | page-kind and guard fixture tests |
| Panel | `createPanel` | One Shadow DOM host; production exposes Home only, diagnostic adds Diagnostics | `dispose()` removes document/window listeners and host | panel lifecycle/browser tests |
| Current-page scan | Home `discover` → `platform.scanJobs` | Results and selection remain in bootstrap memory | Only `job-list` is accepted; scan errors are shown in Chinese | BOSS scan fixtures and browser flow |
| Selection | Home checkbox → `selectedJobIds` | Bound to current URL and card identity; frozen at Start | Empty, stale, missing or contradictory identities refuse Start/scan | `selection.test.ts` |
| Start | Home `start` → controller `START` | Frozen selected snapshot becomes reducer `pendingSummaries` | Double start, unhealthy storage, non-owner and verification state refuse | state/controller/bootstrap composition tests |
| Finite batch | reducer + orchestrator | Reducer `pendingSummaries` is the only authoritative batch queue | Every item drains once; completed batches terminate with `completed`, never rescan | state-machine model tests |
| Load job | orchestrator `load-job` → BOSS platform | Loaded detail becomes `currentJob` | AbortController rejects stale results; load failure terminates the batch | orchestrator race tests |
| Evaluate | rule engine through orchestrator | Hard rejection always wins; explicit selection may bypass soft score only | Rejections are logged and advance to the next selected item | orchestrator/state tests |
| Open chat | communication runner → action `openConversation` | Intent target contains platform job id plus corroborating identity | Exact contact control only; wrong/insufficient chat identity aborts | communication-action/runner tests |
| Prepare | communication runner → action `prepareMessage` | Editor is not persisted | Existing draft is never overwritten; challenge/unknown DOM blocks | runner/action tests |
| Authorize | service callback invoked by runner immediately before send | Durable intent read-back, storage health, tab ownership and limits are re-evaluated | Missing callback fails closed; disconnected callback cannot report success | service/runner composition tests |
| Send | communication runner only → action `dispatchSend` | `sendAttemptedAt` is durably persisted before click; `clickDispatched` after click | No blind retry. Reload or cancellation after commit becomes `SEND_UNCERTAIN` | duplicate-send regression and mutation checks |
| Verify | communication runner → `observeSend` | Success requires an outgoing-message count above the chat-specific baseline | Bounded polls; timeout remains uncertain and preserves the intent | runner tests |
| History and next item | orchestrator + reducer | Only observed send becomes submitted/verified and increments the session count | Skip advances; uncertain/block pauses without advancing | orchestrator/state tests |
| Stop / pause / route change | controller | Terminal reason is explicit | Active AbortController and scheduled timers are cancelled; expected detail→chat transition is retained | controller/state race tests |

## Single sources of truth

- Batch membership and progress: reducer `pendingSummaries`, populated only
  from the frozen current-page selection. The legacy infrastructure task queue
  is not part of production composition.
- Irreversible communication: `CommunicationRunner` is the only sender;
  `CommunicationService` owns application gates and durable intent setup; the
  BOSS communication action is the only DOM click boundary.
- Interactive production UI: Home. Legacy workspace/search/pipeline renderers
  are not mounted by the shipped panel; diagnostic controls exist only in the
  diagnostic channel.

## Fail-closed boundaries

Unknown page state, missing selectors, contradictory job identity,
insufficient chat identity, a user draft, unhealthy persistence, ownership
loss, human verification, an existing intent, and an unverified send all stop
the batch. None broadens a selector, selection, or retry budget.
