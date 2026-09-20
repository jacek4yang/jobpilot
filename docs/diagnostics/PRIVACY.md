# Diagnostic privacy policy

This document states what JobPilot's diagnostics record, what they never record,
and — the important part — **how that is enforced in code rather than promised in
prose**.

Source of truth: `src/diagnostics/redact.ts`, `src/diagnostics/recorder.ts`,
`src/diagnostics/bundle/bundle.ts`. Design rationale:
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

> **Status.** The mechanism is implemented and unit-tested. It has not been
> exercised against a real BOSS Zhipin session, because no such session has been
> run. Nothing here is a claim that the live site was inspected.

---

## 1. The policy in one sentence

A diagnostic bundle is **safe to send to a developer**: it contains structured
evidence about what JobPilot did, and none of the user's credentials, content or
conversation.

---

## 2. Enforcement: redaction happens at WRITE time

This is the single most important property of the design, and everything else
follows from it.

**Values are redacted before they enter any buffer, not when the bundle is
exported.**

```
caller
  └─ recorder.record({ data })
       └─ toSafeData(data)              <- src/diagnostics/recorder.ts
            └─ redactDiagnostic(data)   <- src/diagnostics/redact.ts
                 └─ ring buffer         <- only sanitised values are ever stored
```

`toSafeData` is applied on **every** write path — `record`, `trace`, `infoEvent`,
`warnEvent`, `errorEvent` and the `Logger` port's `debug`/`info`/`warn`/`error`.
There is no path into the buffers that skips it.

The consequence, stated in the module's own header:

> A value that never enters a buffer cannot leak through a future export path, a
> new bundle file, or a bug in the exporter.

Export-time redaction would be a single point of failure: every new export path,
every new bundle file and every refactor would have to remember to sanitise. With
write-time redaction, adding a new file to the bundle is **safe by default**. The
exporter additionally redacts again as defence in depth
(`redactForBundle`), but that is a second line, not the first one.

Redaction is also applied to **nested** values, not just the top level, and the
recorder's `Logger` port implementation passes the whole payload — including
`context` — through the same path, so an object hidden one level down cannot
bypass it.

Depth is bounded at 6; deeper values become `[depth-limit]`. Arrays are truncated
at 50 elements. Both bounds exist so a caller that accidentally passes a huge
structure produces a visible marker rather than an enormous event.

---

## 3. What is never recorded

Outright, in any form:

- cookies
- authorization headers
- tokens (including bearer tokens)
- session ids
- passwords
- resume contents
- chat history
- recruiter messages
- user drafts
- full message bodies
- complete page HTML

The same list is asserted in the bundle's own `README.txt`, so a recipient of an
archive sees the claim without needing this document.

### How each category is kept out

Two mechanisms, applied by `redactDiagnostic` in a fixed order:

**Order of operations**

1. Known-sensitive **keys** are dropped outright and replaced with the literal
   `[redacted]`.
2. Content-bearing **keys** are replaced by a fingerprint (length + digest).
3. Every **string** is scanned for credential shapes and scrubbed.
4. Everything else falls through to the base logger's `redact` for a final pass.

#### 3.1 Outright replacement — credential-shaped keys

A key is normalised (lowercased, `-`, `_` and whitespace removed) and matched
against:

```
cookie   token   password   secret   credential   authorization
```

Any match replaces the **value** with `[redacted]`. The key itself is kept, so
`{"authorization": "[redacted]"}` still tells an analyst that an authorization
header existed — which is often the diagnostic question — without recording it.

#### 3.2 Fingerprinting — content-bearing fields

`HASHED_FIELDS` names the fields whose *content* is sensitive but whose *shape*
is diagnostically useful:

```
messagebody   messagecontent   messagetext   chatcontent   chattext
conversationtext   drafttext   draftcontent   resumetext
html   outerhtml   innerhtml   pagehtml
```

A string value under one of these keys is replaced with a `TextFingerprint`:

```ts
{ length: number, sha256OrFnv: string, preview?: string }
```

The value becomes `{ length, sha256OrFnv }`, and the content is gone.

#### 3.3 String scrubbing — credential shapes

Independently of the key, every string passes through `redactString`:

- `Bearer <token>` / `Basic <token>` → `[redacted]`
- `token=… `, `sessionid=…`, `session_id=…`, `password=…`, `authorization=…`,
  `csrf=…` → `key=[redacted]`
- any bare run of 15–18 digits → `[id-number]` (national id numbers)

Then a **fallback**: if the string *mentions* one of `SENSITIVE_MARKERS` —

```
cookie authorization "bearer " token password passwd secret
sessionid session_id csrf resume 简历 身份证
```

— and no pattern matched, the whole string is replaced with
`[redacted:<fingerprint>]` rather than being recorded verbatim. The comment in
the source explains the intent: record a fingerprint instead of **risking a leak
we did not anticipate**.

Note the distinction the code makes deliberately: *a string that merely mentions
a sensitive word is not itself sensitive, but a string containing an assignment
or a bearer token is.* "the authorization check failed" survives; "authorization:
Bearer eyJhbGci…" does not.

---

## 4. Why a digest, and not deletion

For content-bearing fields, the choice is between dropping the value entirely and
replacing it with a length plus a digest. **We keep the digest**, because it
answers the questions that actually come up during triage:

| Question | Answered by |
|---|---|
| Was the draft empty? | `length === 0` |
| Did the message change between run 1 and run 2? | digest comparison |
| Did the editor contain the text we inserted? | digest comparison against the prepared text |
| Is this the same conversation as the last run? | digest comparison |

None of these require reading the content. That is the whole point: **change
detection without recoverability.**

**What the digest is.** `fingerprintText` is **FNV-1a**, rendered as
`fnv1a:xxxxxxxx`. It is *not* SHA-256, and the source is explicit about why:
this runs synchronously on hot paths inside a content script, and the requirement
is change detection, not cryptographic strength. `TextFingerprint.sha256OrFnv`
is named that way to avoid implying SHA-256 where FNV-1a was used.

Two honest caveats, so nobody over-claims:

- FNV-1a is 32-bit. It is not collision-resistant and must not be treated as a
  security boundary. Its role is "did this change", not "prove this is secret".
- Low-entropy content is guessable from a digest by brute force. An empty draft,
  or a draft of three characters, can be recovered by enumerating candidates.
  This is accepted: such content carries no privacy value, and the alternative —
  recording nothing — would make the "was the draft empty?" question
  unanswerable. **Do not extend digest-based recording to high-entropy fields**
  (a resume, a full message body, a token); those are in the never-recorded list
  for exactly this reason.

A separate, correctly-implemented SHA-256 (`bundle/hash.ts`) is used for bundle
file checksums. It never touches user content — only the sanitised text of the
bundle's own files. The two must not be confused.

**The `preview` escape hatch.** `fingerprint(value, { safe: true, previewChars })`
can include a leading slice of the text. `safe` must be set deliberately by the
caller, and is intended only for text JobPilot itself generated or for structural
page labels — **never for user content**. With `safe` unset, no preview is
emitted.

---

## 5. The outgoing-message case

This is the highest-risk content JobPilot handles: the exact text of a message it
is about to send. The rule is that the **text is never recorded**.

For an outgoing message, diagnostics record only:

```
templateId        which template produced it
messageLength     how long the result was
messageSha256     a digest, so "did the text change between runs" is answerable
variablesUsed     the NAMES of the variables substituted, not their values
```

`variablesUsed` is names only. A template variable `{{company}}` resolves to an
actual company name at send time; what is recorded is the string `"company"`, so
the analyst learns which placeholders fired, not what they expanded to.

**Why the names and not the values.** "The message was built from the wrong
template", "a variable failed to substitute" and "the length is zero" are the
real failure modes, and every one of them is visible from the names, the length
and the digest. The values add nothing diagnostic and everything sensitive.

The persisted `CommunicationIntent` in the domain does hold `messageText` — it
has to, so that after a crash JobPilot can count outgoing messages matching the
intended text and decide `verified` vs `uncertain` (see
`docs/product/boss-workflows.md` §3.2). **That is product state, not diagnostic
state.** It lives in the storage document under `jobpilot:root:v1`; it does not
enter the diagnostic event stream, and a bundle containing it would be a bug of
the same severity as recording a token.

### DOM evidence

`dom-diagnostics.json` never contains full HTML. `html`, `outerhtml`, `innerhtml`
and `pagehtml` are all in `HASHED_FIELDS`, so even if a caller passes an element's
markup it is reduced to a length and a digest. What *is* recorded is bounded and
semantic: selector outcomes (selector, declared confidence, match counts,
accept/reject reason) and element fingerprints (tag, id, classes, role,
aria-label, selected `data-*` attributes, a text fingerprint, a rect).

---

## 6. Configuration and environment

- `config.redacted.json` is the configuration document with sensitive values
  removed. It passes through `redactForBundle`, which applies
  `redactDiagnostic` and then the base logger's `redact`.
- `environment.json` records browser and page context. It is redacted on the way
  out and **contains no browser fingerprinting** — the lock tracer's `tabId` is
  explicitly documented as opaque for the same reason.
- The storage tracer records **only** the key namespace, success/failure, the
  serialised byte size and a duration. It never records the stored value. The
  serialised size is computed inside a `try` and discarded on failure.

---

## 7. Export-time redaction as defence in depth

`redactForBundle` is applied by `buildBundle` to:

- `environment.json`
- `storage-summary.json`
- `config.redacted.json`
- **every subsystem-supplied section** that is not one of the built-in sections

So a section added by a future subsystem is redacted even if its author never
thought about privacy. Because write-time redaction already ran, this second pass
normally finds nothing to do. It exists so that a single missed write path is not
a leak.

---

## 8. The privacy test as a CI gate

A privacy test seeds fake secrets into every likely sink, generates a bundle, and
asserts that none of them appear anywhere in the ZIP. It is a **CI gate**: a
failure blocks the change.

What it asserts:

1. **No planted secret appears in any file** in the archive, searched as raw
   text across every entry — not just the file where it was planted. The search
   is over the whole archive, so a value cannot escape by being copied into a
   section nobody thought to check.
2. **Coverage across sinks.** Secrets are planted in the event `data` payload, in
   nested `data`, in `Logger` context, in the config, in the environment and in a
   subsystem section, so that a bypass in any one write path is caught.
3. **Both known credential shapes and content fields** are exercised, so neither
   the key-based replacement nor the fingerprinting path can silently regress.
4. **The bundle still contains its structure.** The test asserts the bundle is
   usable — manifest, summary, checksums present — because a "privacy" test that
   passed by producing an empty archive would be worthless.
5. **Checksums remain valid** after redaction, proving sanitisation happens
   before hashing rather than corrupting the archive afterwards.

What it does **not** claim: that no possible secret can ever leak. It asserts
that the specific classes the policy names, planted in the sinks that exist
today, do not appear. That is why new sinks must be added to the test when they
are added to the product.

---

## 9. Defaults: no telemetry, no upload, no server

- There is **no telemetry**, and no code path that enables it. The configuration
  schema contains a `telemetryEnabled` field that is hard-defaulted to `false`
  and is never turned on by any code path (see `README.md`).
- There is **no upload**. A bundle is written to a local destination the operator
  chooses — a directory via the File System Access API, or a normal browser
  download. It is never transmitted anywhere.
- There is **no external server**. JobPilot runs entirely in the page. It has no
  account, no backend and no network egress of its own.
- JobPilot **never claims filesystem access it does not have**, and never writes
  outside the user-granted root. Permission is requested explicitly and revocation
  is handled gracefully.

The corollary is stated in `README.md` §Known limitations: with no telemetry there
is no crash reporting, so diagnostics stay in the browser and only your own
exported bundles will say what happened.

---

## 10. Handling guidance for the operator

- **A bundle is safe to share with a developer.** That is the design goal, and
  the CI gate exists to keep it true.
- **A bundle is still evidence, not a public artefact.** It contains the URL
  routes you visited, the timings of everything you did, selector outcomes, and
  configuration values that were not classified as sensitive. Treat it as you
  would a log file from your own machine.
- **`test-results/` is gitignored.** Real session bundles are never committed.
  Only sanitized, minimal fixtures may be committed — see
  [`../live-testing/RUNBOOK.md`](../live-testing/RUNBOOK.md).
- **If you believe a bundle contains something it should not**, stop and treat it
  as a defect in the redaction policy. Do not share the bundle; keep it, and
  report which field and which file. The correct fix is a new rule plus a new
  assertion in the privacy test — not a manual edit of the archive.
