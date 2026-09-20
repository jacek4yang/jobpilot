# BOSS Zhipin adapter

Adapter for **BOSS Zhipin (zhipin.com)**, implementing the `JobPlatform` port from
`src/ports/job-platform.ts`.

## ⚠️ Verification status: UNVERIFIED

**The real BOSS Zhipin DOM was never inspected while writing this adapter.**

Every selector is validated only against the synthetic fixtures in
`tests/fixtures/boss/`. Those fixtures were hand-authored to match
`src/adapters/boss/selectors.ts` — so a passing test proves the *parser plumbing*
works, and **nothing** about whether the adapter recognises the live site.

`BOSS_METADATA.automationVerified` is the literal `false`, and is typed as a
literal so a false claim cannot be made to compile.

Do not describe this adapter as "working on BOSS Zhipin". It is structurally
complete and fails closed; that is a different claim.

## Selector confidence

Every entry in `SELECTORS` carries a `confidence` field. Run
`allSelectorEntries()` to enumerate them programmatically.

| Confidence | Meaning |
| --- | --- |
| `fixture-only` | Matches our synthetic fixture. Says nothing about the real site. |
| `unverified` | A heuristic guess about real BOSS markup. May match nothing, or the wrong element. |

`fixture-only` is deliberately **not** called "verified". It is the weaker of the
two non-verified categories and exists only to distinguish "we control this
fixture" from "we are guessing".

### Fixture-only (asserted by our own HTML)

These are the entries exercised by the fixtures:

- `list.card`, `list.link`, `list.title`, `list.company`, `list.salary`,
  `list.location`, `list.jobIdAttribute`
- `detail.root`, `detail.title`, `detail.salary`, `detail.location`,
  `detail.companyName`, `detail.tags`, `detail.description`, `detail.applyButton`,
  `detail.alreadyAppliedMarker`
- `guards.captcha`, `guards.loginRequired`, `guards.loginForm`,
  `guards.emptyResult`, `guards.jobDetailRoot`, `guards.jobListRoot`

### Unverified (pure heuristics about the live site)

- `list.tags`
- `detail.companyMeta`, `detail.requirements`, `detail.skills`,
  `detail.recruiterName`, `detail.recruiterTitle`, `detail.applySuccessMarker`,
  `detail.applyDialog`, `detail.applyDialogSubmit`
- `guards.riskControl`

The `[class*='...']` and `[id*='...']` substring candidates in `guards` are the
most fragile part of this file. They over-match on purpose: a false positive
merely pauses automation, whereas a false negative could drive it through a
CAPTCHA.

## Fail-closed behaviour

This is the core design property. Where the adapter is unsure, it stops.

| Situation | Result |
| --- | --- |
| CAPTCHA / risk-control / login page | `BlockReason: "captcha" \| "risk-control" \| "login-expired"` |
| Unrecognised DOM | `PageKind: "unknown"` → `scanJobs()` returns `[]`; `loadJob()` throws |
| Non-zhipin host | `PageKind: "unsupported"` |
| Apply button not matched by a listed selector | `BlockReason: "selector-missing"` — **no text-based fallback** |
| Required detail anchor missing | `parseBossJobDetail` returns `null` → `loadJob()` throws |
| Click produced no confirmation evidence | `ApplyOutcome: "needs-confirmation"` — **never `"submitted"`** |
| Unrecognised education/experience text | `"unknown"`, never a plausible guess |

### The three apply rules

1. **Guard re-check before every click.** Guards are re-evaluated immediately
   before touching the DOM, never cached from page load.
2. **Click only listed selectors.** The apply button is located exclusively via
   `SELECTORS.detail.applyButton`. If nothing matches, the attempt is blocked.
3. **Never infer success.** After clicking, the DOM is re-read for confirmation
   evidence. Absence of evidence is `needs-confirmation`, not `submitted`.

## Files

| File | Purpose |
| --- | --- |
| `selectors.ts` | Single source of truth for all selectors, grouped `list` / `detail` / `guards`. |
| `guards.ts` | Fail-closed detection: captcha, risk-control, login, empty result, host support. |
| `parser/page-kind.ts` | `PageKind` precedence chain + pure, DOM-free signal classifier. |
| `parser/list-parser.ts` | Card parsing into `JobSummary`; skips (never throws on) bad cards. |
| `parser/detail-parser.ts` | `JobDetail` parsing; returns `null` when anchors are missing. |
| `actions/apply-action.ts` | The three safety rules above. |
| `actions/abort.ts` | `AbortSignal` helpers. |
| `diagnostics/boss-diagnostics.ts` | Redacted diagnostic snapshot. |
| `index.ts` | `createBossPlatform()` and `BOSS_METADATA`. |

## Detection order

Classification is a precedence chain, not a set of independent checks — a CAPTCHA
page also contains a login link. Order:

```
captcha → risk-control → login-required → job-detail → job-list → empty-result → unsupported → unknown
```

`detectBossPageKindFromSignals` (pure) and `classifyBySwitch` (exhaustive switch)
encode this twice, deliberately. Tests cross-check the two so an edit that
reorders one without the other fails.

## Diagnostics and privacy

`collectBossDiagnostics` strips the URL query string and fragment and runs every
value through `redact()`. It never reads `document.cookie`, and drops context keys
whose names look like cookies, tokens, credentials or chat content.

## Promoting a selector out of `unverified`

Only with evidence from the real site. Concretely: capture the live markup,
confirm the candidate matches the intended element, then update the entry's
`confidence` and `note` and cite the evidence. Until then, leave
`automationVerified: false` alone.
