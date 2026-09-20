# The BOSS Zhipin adapter

Adapter for **BOSS Zhipin** (`zhipin.com`), implementing the `JobPlatform` port
from `src/ports/job-platform.ts`.

---

## 0. Verification status: UNVERIFIED

**No live-site verification has been performed. The real BOSS Zhipin DOM was
never inspected while writing any part of this adapter.**

This is not a caveat buried in a footnote; it is the most important fact about
the module. Everything below is structured so you can tell, for any given
behaviour, exactly what evidence exists for it.

| Evidence class | Meaning |
| --- | --- |
| **Synthetic fixture** | Our own hand-authored HTML in `tests/fixtures/boss/`. Matching it proves the plumbing works |
| **Unit test on pure logic** | The precedence chain, the parsers and the identity matcher are exercised without a DOM |
| **Nothing** | Nobody has looked at the live site |

There is no row in this table that says "observed on the real site", because no
such observation exists.

Three mechanisms keep this honest:

1. **`SelectorConfidence` has no `verified` value.** The type in
   `src/adapters/boss/selectors.ts` is `"fixture-only" | "unverified"`. A
   selector cannot be marked verified because the type does not admit it.
2. **`BOSS_METADATA.automationVerified` is the literal `false`**, typed with
   `as const` so a claim of `true` fails to compile.
3. **Fixtures were authored to match the selectors**, not captured from the
   site. The dependency direction is the reverse of what a real verification
   would require, and the file headers say so.

`fixture-only` is deliberately **not** called "verified". It is the weaker of the
two non-verified categories and exists only to distinguish "we control this
fixture" from "we are guessing".

There are **32 selector entries** across the two registries. Of those, the
`unverified` ones are listed in §2. Everything else is `fixture-only`.

---

## 1. Selector confidence model

### 1.1 The two registries

| Registry | File | Scope |
| --- | --- | --- |
| Page selectors | `src/adapters/boss/selectors.ts` | List cards, job detail, guards |
| Communication selectors | `src/adapters/boss/communication/selectors.ts` | Chat, editor, send button, modals, risk banner |

Both use the same vocabulary and the same `SelectorEntry` shape:

```ts
export interface SelectorEntry {
  readonly candidates: readonly string[];   // tried in order; first match wins
  readonly confidence: SelectorConfidence;
  readonly note: string;                    // why this order, and what is unknown
}
```

### 1.2 Candidate ordering

Candidates are ordered by robustness, and the order is part of the contract:

1. **Semantic author hooks** — `data-jobpilot-*`. These are *ours*; the fixture
   sets them. This is why the entry is `fixture-only`.
2. **`itemprop` / `itemtype`** from schema.org `JobPosting` microdata. Real sites
   often emit these, so they are the most plausible real-site anchor. Still
   unverified.
3. **ARIA** roles and attributes.
4. **Stable structure** — `ul.job-list > li.job-card`.
5. **Stable class names** — the most fragile of the structural options.
6. **Limited text fallback** — only in `guards.ts`, and only as a last resort.

`queryFirst` walks the candidates in order and returns which one won, annotated
with `heuristic: boolean`, so diagnostics can distinguish a stable anchor from a
guess.

```ts
export interface LocatedElement {
  readonly element: Element;
  readonly matchedBy: string;
  readonly heuristic: boolean;
}
```

### 1.3 The `fixture-only` entries

These are asserted by our own fixtures.

**List:** `card`, `link`, `title`, `company`, `salary`, `location`,
`jobIdAttribute`.

**Detail:** `root`, `title`, `salary`, `location`, `companyName`, `tags`,
`description`, `applyButton`, `alreadyAppliedMarker`.

**Guards:** `captcha`, `loginRequired`, `loginForm`, `emptyResult`,
`jobDetailRoot`, `jobListRoot`.

**Communication:** `chatRoot`, `chatEditor`, `chatHeader`, `jobTitleInChat`,
`companyInChat`, `chatJobIdAttribute`, `commonPhraseToggle`, `commonPhrasePanel`,
`commonPhraseItem`, `sendButton`, `outgoingMessage`, `outgoingMessageBody`,
`messageSendFailed`, `successModal`, `successModalStayButton`, `riskBanner`.

### 1.4 The `unverified` entries

Pure heuristics about the real site. These may match nothing, or match the wrong
element.

| Group | Entry | Why it is a guess |
| --- | --- | --- |
| `list` | `tags` | Tag text on real BOSS cards is not a documented contract. Consumers must treat it as advisory |
| `detail` | `companyMeta` | Real industry/stage/size markup is unknown; each item's text is matched against coarse Chinese keyword tables |
| `detail` | `requirements` | Heuristic. Returns a multi-element list, so it is read with `queryAllFirst` |
| `detail` | `skills` | Heuristic keyword chips; treated as advisory hints only |
| `detail` | `recruiterName` | Absence simply yields no recruiter |
| `detail` | `recruiterTitle` | Used only for display and the 猎头 substring check |
| `detail` | `applySuccessMarker` | Post-click confirmation evidence. If it does not appear the action returns `needs-confirmation` |
| `detail` | `applyDialog` | BOSS often shows a greeting/consent dialog. Its presence downgrades the outcome |
| `detail` | `applyDialogSubmit` | Used only to *describe* the dialog. The adapter does not auto-submit dialogs |
| `guards` | `riskControl` | Real risk-control interstitials are not documented; `[class*='risk']` may over-match decorative class names |
| `communication` | `unknownModal` | These class names may match cookie banners or ad overlays, classifying as `unknown` and pausing automation |

Also unverified in substance, though the group is `fixture-only`: the
`[class*='...']` and `[id*='...']` substring candidates inside
`guards.captcha` and `guards.loginRequired`. They are the most fragile part of
the registry, and they over-match **on purpose** — a false positive merely pauses
automation, whereas a false negative could drive it through a CAPTCHA.

### 1.5 Promoting a selector

Only with evidence from the real site. Concretely: capture the live markup,
confirm the candidate matches the intended element, then update the entry's
`confidence` and `note` and cite the evidence in the commit. Until then, leave
`automationVerified: false` alone — there is no code change that can honestly set
it to `true` today.

---

## 2. Guard and block detection

`src/adapters/boss/guards.ts` answers one question: *should automation refuse to
continue?* It is deliberately biased towards **yes**.

### 2.1 The design rule

> A false positive costs the user one manual click ("Resume"). A false negative
> could drive automation through a CAPTCHA or a risk-control interstitial.
> Every ambiguity resolves to "blocked".

### 2.2 The guards

Each guard tries structural candidates first, then falls back to visible text —
text being the weakest evidence, since it can appear in help copy or a footer.

| Guard | Structural anchors | Text fallback |
| --- | --- | --- |
| `detectCaptcha` | `[data-jobpilot-guard='captcha']`, `#captcha`, `.captcha-container`, `[class*='geetest']`, `[id*='captcha']` | `请完成安全验证`, `请完成验证`, `滑动验证`, `拖动滑块`, `captcha` |
| `detectRiskControl` | `[data-jobpilot-guard='risk-control']`, `[class*='risk']`, `[class*='verify-wrap']` | `操作过于频繁`, `当前操作存在风险`, `访问受限`, `安全中心`, `risk control` |
| `detectLoginRequired` | `[data-jobpilot-guard='login-required']`, `[data-jobpilot-guard='login-expired']`, `.login-register`, `.sign-wrap`, `[class*='login-dialog']`, then the `loginForm` entry | `登录后查看`, `请先登录`, `登录/注册`, `验证码登录` |
| `detectEmptyResult` | `[data-jobpilot-guard='empty']`, `.job-list-empty`, `[class*='empty-wrapper']` | `暂无职位`, `没有找到相关职位`, `换个关键词试试`, `无符合条件的职位` |

Every guard returns a discriminated `GuardSignal`:

```ts
export type GuardSignal =
  | { readonly detected: true; readonly evidence: string }
  | { readonly detected: false; readonly evidence: "" };
```

`evidence` is short and already redacted — the tag name and the selector that
matched, never the element's text content, which on a login or CAPTCHA page can
include account identifiers.

### 2.3 Severity order

`blockingReasonFrom` maps the highest-severity fired guard onto a
`BlockReason`, in a fixed order:

```
captcha  >  risk-control  >  login-expired
```

A CAPTCHA page also contains a login link; the order is what makes the reported
reason the *right* one.

### 2.4 Host support

```ts
export const SUPPORTED_HOSTS: readonly string[] = ["zhipin.com", "www.zhipin.com"];
```

Only these two exact hostnames are accepted. Subdomains such as `m.zhipin.com`
are *structurally* `zhipin.com` but were never inspected, so `isSupportedHost`
returns `false` for them. `isUnverifiedZhipinSubhost` reports the case separately
so diagnostics can distinguish "not BOSS" from "looks like BOSS but unvalidated".

An unparsable or relative URL returns `false`. The function never throws.

### 2.5 JobPilot never does any of this

It does not dismiss, solve, retry through, or navigate around a verification
page. It does not log in on the user's behalf — `loginForm` is used only by the
text fallback in `detectLoginRequired` and is never clicked. There is no code path
that does otherwise.

---

## 3. Page-kind taxonomy

`PageKind` (from `src/ports/job-platform.ts`):

```
job-list · job-detail · login-required · captcha · empty-result
unsupported · unknown
```

`unsupported` and `unknown` are first-class, blocking outcomes, not error states.

### 3.1 The precedence chain

Classification is a **precedence chain, not a set of independent checks**. A
CAPTCHA page also contains a login link; an empty-result page also contains a
job-list root. Evaluating them out of order would misclassify.

```
unsupported-host   (safety gate: checked before ALL structural evidence)
  -> captcha
    -> risk-control
      -> login-required
        -> job-detail
          -> job-list
            -> empty-result
              -> unknown
```

The host gate runs first deliberately. A page that merely *looks* like BOSS — a
clone, a mirror, a saved copy served from another origin — must never be treated
as BOSS, because every downstream action would then run against a document we do
not trust at all.

### 3.2 Two encodings, cross-checked

`detectBossPageKindFromSignals` (a pure precedence chain over a plain signals
object) and `classifyBySwitch` (an exhaustive `switch` over a computed index)
encode the ordering **twice, deliberately**. Tests cross-check the two, so an edit
that reorders one without the other fails. Do not "simplify" `classifyBySwitch`
into a call to the other — that would remove the cross-check.

Because `PageKindSignals` is DOM-free and boolean, the chain is unit-testable
exhaustively with no DOM at all.

### 3.3 Decisions carry a reason

```ts
export interface PageKindDecision {
  readonly kind: PageKind;
  readonly reason: PageKindReason;
}
```

`PageKindReason` distinguishes `captcha-guard`, `risk-control-guard`,
`login-guard`, `detail-root-present`, `list-root-with-cards`,
`list-root-without-cards`,
`zero-cards-with-empty-marker-and-no-list-root`, `unsupported-host`, and
`no-evidence`. Diagnosis is therefore possible without re-deriving the chain.

### 3.4 Two counter-intuitive outcomes, observed

Both were read off the running product in the browser suite, and both are
recorded in `OBSERVED_PAGE_KIND` in `tests/browser/harness.ts`:

- **`unsupported.html` reports `unknown`, not `unsupported`.** The harness serves
  it from `www.zhipin.com`, so the host gate does not fire and the classifier
  falls through to structural evidence, which finds nothing. `unsupported` is only
  reachable from a non-BOSS hostname.
- **`risk-page.html` reports `captcha`.** The CAPTCHA guard outranks risk control
  in the precedence chain, so a page with both signals is classified as a CAPTCHA.
  Additionally, `risk-control` maps to `kind: "unknown"` in the decision function,
  with `reason: "risk-control-guard"` — the block reason is `risk-control`, but
  the page kind is not a distinct value.

Also worth knowing: a list root with zero cards is `empty-result`, and cards
without a recognised container are still unambiguously `job-list`. Cards always
win over emptiness, so a stale "no results" banner cannot mask a populated list.
`emptyResultMarker` only counts when nothing else claimed the page.

---

## 4. The two-stage evaluation

`src/domain/matching/two-stage.ts`. The point of staging is that a rejected job
never costs a navigation.

### 4.1 Stage A — card data only

Runs on `JobSummary`, straight from the list. Rejects only on **positive
evidence**:

| Check | Rejects when |
| --- | --- |
| Already contacted | The job id is in history as submitted or verified |
| Exclude keywords | Title or company contains one |
| Company blacklist | Company contains an entry |
| Title blacklist | Title contains an entry |
| Cities | A city is shown and none matches the profile |
| Salary floor | The card shows a parseable range whose max is below the profile minimum |

Deliberately conservative about missing data: **a card that does not show a
salary is not rejected for salary**, because the card simply may not render it.
Only positive evidence rejects.

### 4.2 Stage B — detail required

Runs only on survivors, and only by opening each one. Hard rejections short
circuit before scoring, so the user sees the decisive reason rather than a wall of
partial scoring.

| Check | Rejects when |
| --- | --- |
| Exclude keywords | Title, description, skills or requirements contain one |
| Include keywords | The list is non-empty and none matches |
| Degree | The posting requires a degree outside the profile's accepted set |
| Experience | The posting requires a band outside the profile's accepted set |
| Recruiter activity | `evaluateActivity` says skip |

Then soft scoring: `baseScore` plus every applicable delta, clamped to
0–100 and rounded, accepted when `>= acceptThreshold`.

```ts
export const SCORE_WEIGHTS = {
  activity: 10,
  salaryAboveTarget: 10,
  companyScale: 5,
} as const;
```

Preferred skills and industries contribute their configured weights. `score` must
always equal `baseScore` plus the sum of every delta pushed into `reasons` — any
contribution that is *reported* must actually be *applied*, or the explanation the
user sees would overstate the score.

### 4.3 Survivors are opened by the discovery service

`src/application/discovery.ts` orchestrates the pipeline:

```
profile -> validate cities -> detect page -> scan cards
        -> stage A -> for each survivor: loadJob -> stage B -> matches
```

Two properties matter more than throughput: stage A runs before anything is
opened, and **discovery never enqueues**. It returns matches for human review; the
caller builds the queue from an explicit selection.

A job that cannot be opened is recorded as rejected with a `DETAIL_TIMEOUT`
reason — never silently dropped, so the user can see why it is missing. An
unresolvable city stops discovery before any scan. An `unknown` or `captcha` page
stops it before touching the DOM.

---

## 5. The communication transaction

This is the most safety-critical flow in the product. Sending a first message to
a recruiter is irreversible.

### 5.1 Intent phases and the point of no return

`src/domain/communication/intent.ts`:

```
armed → navigating → chat-verified → prepared
      → send-attempted → { verified | uncertain | failed }
```

- `SAFE_TO_ABANDON` = `armed`, `navigating`, `chat-verified`, `prepared`.
- `TERMINAL_PHASES` = `verified`, `uncertain`, `failed`.
- **`send-attempted` is the point of no return.**

The single auditable guard:

```ts
export const canClickSend = (intent: CommunicationIntent): boolean =>
  intent.phase === "prepared" && intent.sendAttemptedAt === undefined;
```

`SEND_DISPATCHED` is the only event that produces `send-attempted`, and it is only
legal when `canClickSend` is true. After it, `canClickSend` is `false` forever: no
reload, timeout, retry or recovery path can click send again. The only legal
continuations are verification outcomes.

### 5.2 The record

```ts
export interface CommunicationIntent {
  readonly id: string;
  readonly jobId: JobId;
  readonly sourceUrl: string;
  readonly expectedJobTitle?: string;
  readonly expectedCompany?: string;
  readonly expectedRecruiter?: string;
  readonly phase: IntentPhase;
  readonly messageText: string;
  readonly outgoingBaseline: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sendAttemptedAt?: number;
  readonly failure?: CommunicationFailure;
  readonly detail?: string;
}
```

`messageText` and `outgoingBaseline` are recorded **before** the send purely so
that verification after a crash is possible. Without the baseline, "did my message
appear?" is unanswerable after a reload, and the transaction would have to guess.

`deserializeIntent` returns `undefined` rather than a best-effort object when the
persisted record is malformed. A corrupt intent must never be able to authorise a
send.

### 5.3 Verify-only recovery

Once `send-attempted` is persisted, recovery is verification and nothing else:

1. Re-locate the conversation for the job id.
2. Count outgoing messages whose body matches `messageText`.
3. Count **strictly greater** than `outgoingBaseline` → `verified`.
4. Count equal or lower → **`uncertain`**, never `failed`. The click may have been
   lost, or the message may render differently than expected.
5. `uncertain` requires human resolution and is never auto-retried.

`EXPIRED` follows the same split: expiring before a send abandons safely; expiring
after a send is `uncertain`.

### 5.4 Chat identity verification

Sending into the wrong conversation is a privacy failure, not a glitch.
`matchChatIdentity` in `src/domain/communication/identity.ts` uses a documented
precedence:

```
job id  >  title + (company | recruiter)
```

- If both sides have job ids and they do not intersect → `mismatch`, **even if the
  text matches**. Two different postings at the same company must not be
  conflated.
- A job-id match is sufficient on its own, because chat headers do not always
  repeat the title.
- Without a usable id, a title match alone is not enough; the company or recruiter
  must corroborate it.
- Missing evidence yields `insufficient`, never `match`.

`insufficient` is treated exactly like `mismatch` by the runner: without positive
evidence, this is not the conversation we were told to write into.

Text normalisation strips whitespace, `·•-—_（）()【】[]`, and one trailing company
legal-form suffix — longest first, so `股份有限公司` is tried before `有限公司`,
otherwise stripping the short form from `示例股份有限公司` would leave a dangling
`股份`.

Job ids read off the DOM are validated by `isPlausibleJobId` before being trusted:
anything with whitespace, a character outside `[A-Za-z0-9_-]`, or a length over 64
is rejected. The bias is towards rejecting, because a false negative merely
weakens identity evidence while a false positive could match the wrong job.

### 5.5 Draft protection

A draft written by the user is sacred. `prepareMessage` checks it in a deliberate
order and refuses at the first problem:

1. Guards (captcha / risk / login / chat risk)
2. Conversation identity
3. **An existing draft** — reported as `draft-present` with the text that is
   already there, and the editor is **not touched**
4. Missing editor or missing send button → `selector-missing`
5. The write itself

The draft is checked *before* the send button is even located, because there is no
point confirming a send path we must not use. After writing, the editor is
re-read and the content compared against the intended text — a framework that
rejected the synthetic events leaves the editor empty, and reporting `ready` then
would send an empty message.

`dispatchSend` re-checks the editor on the click path. If the user typed something
between prepare and dispatch, that content is theirs and is not sent.

### 5.6 The send button

`sendButton` is the one group whose text is load-bearing. The label must be
**exactly** `发送` — never a substring match, never an icon, never a group. That
rejects decorative icons, `发送中`, `重新发送`, and any container whose text merely
contains the word. A miss yields `BlockReason: "selector-missing"`, and there is
**no fallback that clicks a text-similar node**.

`successModalStayButton` is reported as evidence only. The adapter never clicks a
dialog button on the user's behalf, because the choice between `留在此页` and
`继续沟通` is the user's.

### 5.7 Counting successes

`messageSendFailed` **must** be excluded from any success count: a bubble reading
`发送失败` is the opposite of evidence that a message was delivered, and `发送中`
has not been delivered yet. The failure filter is applied to the *outer* bubble,
not to the message body, because if the body selector misses, the outer text —
which includes the `发送失败` marker — is what gets read.

`successModal` requires both the structural anchor and the visible text token
`已向BOSS发送消息`. A bare skin class alone can never classify as success.

### 5.8 The runner's ordering

`src/application/communication-runner.ts` is the only module permitted to reach
the click, and it does so at most once per intent. Its ordering is the safety
model:

1. Refuse on a block signal before anything is touched.
2. Read the conversation; confirm identity before writing.
3. Prepare, which refuses to overwrite a draft.
4. `canClickSend` is consulted; then `send-attempted` is **persisted before the
   click is dispatched**. The window between those two statements is recoverable
   as `uncertain`, which is exactly what must happen if the page reloads.
5. Verify by observing an outgoing delta, polling with a timeout. Not observed
   within budget → `uncertain`.

---

## 6. The city table and its provenance

BOSS's search uses a 9-digit city code, not a city name. Resolving a name to a
code is a prerequisite for building a search URL, and getting it wrong silently
would send the user to the wrong city's results.

### 6.1 Provenance

`src/adapters/boss/data/city-codes.ts` holds **377 entries**, each mapping a
Chinese city name to a 9-digit code.

**Where it came from:** the public city table published in
`eatmoreduck/boss-zhipin-scraper` (`data/city_codes.json`, MIT-licensed,
retrieved via the GitHub contents API). That table is BOSS's own public city
taxonomy, vendored so JobPilot can resolve an arbitrary supported city without a
network call and without guessing.

**What that means, precisely.** This is a vendored third-party transcription of
BOSS's taxonomy. It has **not** been checked against BOSS's own API or site. If
BOSS changes its taxonomy, the table goes stale silently — nothing validates it.
The file is marked "do not hand-edit: regenerate from the upstream table".

The reference analysis describes it as a complete map including `全国` and
prefecture/county-level entries such as `楚雄彝族自治州` and `昌江黎族自治县`.

### 6.2 Resolution policy

`resolveCityCode` is deliberately strict:

- An exact match resolves.
- A 9-digit all-numeric input is accepted as a code, **but only if the table
  contains it**, so a typo cannot smuggle in an arbitrary code.
- A name with one common administrative suffix stripped resolves —
  `特别行政区`, `维吾尔自治区`, `回族自治区`, `壮族自治区`, `自治州`, `自治县`,
  `地区`, `盟`, `省`, `市`, `县`, `区`.
- **Anything else FAILS EXPLICITLY.** There is no default city.

```ts
export type CityResolution =
  | { readonly ok: true; readonly code: string; readonly name: string;
      readonly normalized: boolean }
  | { readonly ok: false; readonly reason: "empty" | "unknown";
      readonly input: string; readonly suggestions: readonly string[] };
```

A failure carries `suggestions` — up to five published names that contain, or are
contained by, the input. They are offered for the user to pick, never applied
automatically. `NATIONWIDE_CITY_CODE` is `"100010000"` and
`NATIONWIDE_CITY_NAME` is `全国`.

Discovery validates every city in the profile *before* scanning, and refuses to
start when one does not resolve. The reference scraper independently arrived at
the same policy, documenting that an unrecognised city "exits with an error
instead of silently producing zero results".

---

## 7. Applying to a job

`src/adapters/boss/actions/apply-action.ts`. Three rules, all non-negotiable:

1. **Guard re-check before every click.** Guards are re-evaluated immediately
   before touching the DOM, never cached from page load.
2. **Click only listed selectors.** The apply button is located exclusively via
   `SELECTORS.detail.applyButton`. If nothing matches, the attempt is blocked with
   `selector-missing` — there is no text-based fallback.
3. **Never infer success.** After clicking, the DOM is re-read for confirmation
   evidence. Absence of evidence is `needs-confirmation`, not `submitted`.

### 7.1 Evidence must be visible

`querySelector` happily matches `hidden`, `display:none` and
`aria-hidden="true"` nodes, and real sites routinely keep confirmation banners in
the DOM but hidden. Treating a hidden marker as evidence would manufacture a false
`submitted` or `already-applied`, so `queryVisible` rejects hidden nodes outright.
When visibility cannot be established it returns `false`, which downgrades the
outcome to `needs-confirmation` — the safe direction.

### 7.2 Outcome precedence

| Situation | Outcome |
| --- | --- |
| Aborted signal | Rejects with the abort reason |
| CAPTCHA / risk control / expired login | `blocked` with the matching `BlockReason` |
| Apply button not matched by any listed selector | `blocked` `selector-missing` |
| Button is `disabled` or `aria-disabled="true"` | `blocked` `ambiguous-state` |
| A visible already-applied badge | `already-applied` (a safe terminal state) |
| Element has no callable `click` | `blocked` `ambiguous-state` |
| Post-click visible success marker | `submitted` |
| Post-click visible already-applied marker | `already-applied` |
| Post-click visible dialog | `needs-confirmation` — a dialog is an unanswered question, not a submission |
| No visible marker at all | `needs-confirmation` — **never `submitted`** |

`BlockReason` is the full set: `captcha`, `risk-control`, `login-expired`,
`unknown-dom`, `selector-missing`, `ambiguous-state`, `rate-limited`.

### 7.3 Verification

`verifyApplication` distinguishes three honest outcomes:

- `confirmed` — a visible success or already-applied marker.
- `not-applied` — no marker, and the apply control is still present and enabled.
  This is a genuine *positive* signal that the posting is un-applied.
- `indeterminate` — anything else, including a dialog the adapter refuses to
  answer. Reported honestly rather than guessed either way.

A fired guard yields `indeterminate` with the guard evidence, not a false
negative.

### 7.4 Diagnostics and privacy

`collectBossDiagnostics` strips the URL query string and fragment and runs every
value through `redact()`. It never reads `document.cookie`, and it drops context
keys whose names look like cookies, tokens, credentials or chat content.

---

## 8. What is verified, and what is not

### 8.1 Verified only against fixtures

- That the precedence chain produces the intended `PageKind` **for our synthetic
  HTML**, including the exhaustive signal combination space.
- That the list and detail parsers extract the fields our fixtures contain.
- That the apply action's guard ordering, selector discipline and
  never-infer-success rule hold, given a DOM that matches our selectors.
- That the communication action's refusal ordering holds, given a chat DOM that
  matches our selectors.
- That the editor write path reports failure when the page does not accept the
  text.
- That the identity matcher is conservative on contradictory evidence.
- That the intent machine never permits a second send dispatch.

### 8.2 Verified as pure logic, with no DOM at all

- The city resolver's exact/normalised/failed outcomes and suggestion list.
- `matchChatIdentity`'s precedence, including the id-conflict mismatch.
- `normalizeIdentityText`'s suffix-stripping order.
- `countOutgoingMessages`' equality rules.
- `reduceIntent`'s complete transition table, including expiry and terminal phases.
- `isPlausibleJobId`'s rejection rules.

### 8.3 NOT verified — at all

- **Any selector matching the real BOSS Zhipin DOM.** Not one has been checked
  against the live site.
- **Page classification on the live site.** The regex-free text fallbacks
  (`请完成安全验证` and friends) are guesses about on-page copy.
- **Scanning a real job list**, and every field parsed from it.
- **Opening a real job detail**, and every field parsed from it.
- **Applying to a real job.** The button markup, greeting dialogs, success toasts
  and already-applied badges were never inspected.
- **The real chat DOM**, send button, success dialog and failure markers.
- **Whether a sent message actually appears** in the outgoing region, and in what
  markup.
- **Whether BOSS serves the DOM shapes the `[class*='...']` guards are guessing
  at**, and how often those guards over-match.
- **The city code table against BOSS's own API.** It is a vendored third-party
  transcription.
- **Whether `m.zhipin.com` or any other subdomain would work.** It is rejected on
  purpose, because it was never inspected.

### 8.4 The honest summary

The adapter is **structurally complete and fails closed**. That is a different
claim from "it works on BOSS Zhipin", and only the first one is true.

What the tests establish is that *if* the live DOM resembles the fixtures, the
safety properties hold. Nobody has established that it does.
