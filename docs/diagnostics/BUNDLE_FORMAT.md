# Diagnostic bundle format

**Format version: 1.** This document describes the archive produced by the
diagnostic build's **Finish Test & Export** command.

> **Status: not exercised against a real site.** The format is implemented, its
> writer and reader are unit-tested, and a bundle can be produced and analysed
> end to end in tests. No bundle in this format has yet been produced from a live
> BOSS Zhipin page, and no live-site behaviour is claimed anywhere in this
> document. See [`../diagnostics/ARCHITECTURE.md`](../diagnostics/ARCHITECTURE.md)
> for the design and `README.md` §Known limitations for what is and is not
> verified.

Source of truth for this document:

- `src/diagnostics/bundle/bundle.ts` — assembly, `REQUIRED_BUNDLE_FILES`, manifest
- `src/diagnostics/bundle/zip.ts` — the archive writer and reader
- `src/diagnostics/bundle/hash.ts` — SHA-256
- `src/diagnostics/session.ts` — `bundleFileName`, `sanitizeFileNamePart`

---

## 1. Container

The bundle is a **ZIP archive built entirely in-page**. It is deliberately
minimal:

| Property | Value | Where |
|---|---|---|
| Compression method | **store only** (method `0`, no compression) | `createZip` in `zip.ts` |
| ZIP64 | **not used** | `MAX_ENTRY_BYTES`, `MAX_TOTAL_BYTES` in `zip.ts` |
| Per-entry integrity | **CRC-32** (IEEE 802.3) in the local and central headers | `crc32` in `zip.ts` |
| Per-file integrity | **SHA-256**, recorded in `manifest.json` and `checksums.json` | `sha256Hex` in `hash.ts` |
| Entry timestamps | the session creation time, identical for every entry | `createZip` entry `modifiedAt` |
| Path separator | forward slash, validated by `isSafeEntryPath` | `zip.ts` |

### Why store-only, and why no ZIP64

Both choices are deliberate and are stated in the source comments:

- **Store-only keeps CPU negligible.** A bundle is exported during a live test,
  while the page is being driven. Compressing it would add work at exactly the
  moment timing matters, for files that are small and are going to be read by a
  tool anyway. It also removes any question of the export perturbing a race the
  test is trying to observe.
- **No ZIP64 because the sizes are bounded.** Every buffer has a ring-buffer
  capacity, so an entry cannot approach the 4 GiB ZIP64 threshold. The writer
  **throws** rather than emitting an archive that silently wraps — a loud failure
  at export time is better than a corrupt bundle discovered at analysis time.
- **The method is recorded in both headers**, so if compression is added later a
  reader can still tell which method produced a given entry. The shipped reader
  (`readZip`) rejects any method other than store with
  `unsupported zip compression method; expected store`.

> Operational consequence: a bundle is large relative to its content. Sizes are
> reported in the manifest so an unexpected growth is visible to the operator.

---

## 2. Archive layout

Every entry lives under a single root directory, `jobpilot-diagnostic/`:

```
jobpilot-diagnostic/
├── manifest.json
├── summary.txt
├── README.txt
├── build.json
├── environment.json
├── session.json
├── events.ndjson
├── state-transitions.ndjson
├── errors.json
├── storage-summary.json
├── config.redacted.json
├── checksums.json
└── (subsystem sections: queue.json, transactions.json,
     selector-diagnostics.json, dom-diagnostics.json, …)
```

`manifest.json` is always written **first**; `checksums.json` is written after
every other file it covers. The order of the remaining entries follows the
section order in `buildBundle`.

### Required entries

`REQUIRED_BUNDLE_FILES` in `bundle.ts` lists the entries a consumer may always
expect. The analyzer should treat a bundle missing any of these as malformed:

```ts
// src/diagnostics/bundle/bundle.ts
export const REQUIRED_BUNDLE_FILES: readonly string[] = [
  "manifest.json",
  "summary.txt",
  "README.txt",
  "build.json",
  "environment.json",
  "session.json",
  "events.ndjson",
  "state-transitions.ndjson",
  "errors.json",
  "storage-summary.json",
  "config.redacted.json",
  "checksums.json",
];
```

Note that `queue.json`, `transactions.json`, `selector-diagnostics.json` and
`dom-diagnostics.json` are **not** in this list. They are supplied by subsystems
through `BundleInputs.sections`, so they are present whenever those subsystems
are wired, but a consumer must not assume them. The analyzer should report a
missing optional section as a reduced-evidence finding, not as a corrupt bundle.

---

## 3. File-by-file contents

| File | Contents |
|---|---|
| `manifest.json` | The self-describing header. See §4. |
| `summary.txt` | **Start here.** Plain text, no JSON required. See §5. |
| `README.txt` | Static text: what the archive is, that it is safe to share, the file list, and the analyze commands. |
| `build.json` | `BuildInfo` — `appVersion`, `gitCommit`, `buildTimestamp`, `channel`, `schemaVersion`, `diagnosticSchemaVersion` — plus `bundleFormatVersion` and `redactionPolicyVersion`. |
| `environment.json` | Browser and page context. Redacted on the way out. |
| `session.json` | `{ sessionId, session, stats }`. `session` is the `DiagnosticSession` or `null` if the export was taken with no named session; `stats` are the recorder's `recorded` / `dropped` / `truncatedBatches` / `criticalDropped`. |
| `events.ndjson` | The full retained event stream, oldest first. One JSON object per line. |
| `state-transitions.ndjson` | The subset of `events.ndjson` whose `event` starts with `state.transition`. |
| `errors.json` | Events whose `category` is `error`, **or** whose level is `fatal`, **or** whose event is `error.invariant_violation`. |
| `storage-summary.json` | Persistence health and per-operation outcomes from the storage tracer. Redacted. |
| `config.redacted.json` | The configuration document with sensitive values removed. Redacted **again** on the way out. |
| `checksums.json` | `{ "algorithm": "sha256", "files": { "<path>": "<hex>" } }`. |
| `queue.json` | *(optional)* Queue snapshot: items, statuses, attempts. |
| `transactions.json` | *(optional)* Communication transactions and the evidence for each phase. |
| `selector-diagnostics.json` | *(optional)* Per-candidate selector outcomes — the selector, its declared confidence, match count, visible match count, context-validation result and accept/reject reason. |
| `dom-diagnostics.json` | *(optional)* Bounded semantic DOM evidence. **Never full HTML.** |

Full page HTML is never exported. DOM evidence is limited to selector outcomes
and element fingerprints (tag, id, classes, role, aria-label, selected `data-*`
attributes, a text fingerprint, a rect). See
[`PRIVACY.md`](./PRIVACY.md).

---

## 4. Manifest fields

`manifest.json` is the only file a consumer must read to decide whether it can
trust and parse the rest.

| Field | Meaning |
|---|---|
| `bundleFormatVersion` | **Layout** version of this archive. Currently `1` (`BUNDLE_FORMAT_VERSION`). |
| `diagnosticSchemaVersion` | Version of the diagnostic event/config schema the build understands. Mirrors `BuildInfo.diagnosticSchemaVersion`. |
| `redactionPolicyVersion` | Version of the redaction policy that produced this bundle (`REDACTION_POLICY_VERSION`, currently `1`). |
| `appVersion` | JobPilot version that produced the bundle. |
| `gitCommit` | Commit the build was made from, or the literal `"unknown"` when git was unavailable at build time. Never faked. |
| `buildTimestamp` | Build time. |
| `channel` | `"production"` or `"diagnostic"`. A full bundle comes from the diagnostic channel. |
| `schemaVersion` | Persistence schema version the build writes. |
| `sessionId` | The session these events belong to, or `pre-session` if no session was started. |
| `scenarioId` | The scenario identifier the operator entered, or `null`. |
| `scenarioName` | The scenario name the operator entered, or `null`. |
| `sessionStatus` | `running` / `completed` / `failed` / `blocked` / `aborted`, or `null`. |
| `createdAt` | Export time, epoch milliseconds. |
| `files` | Every entry path, relative to `jobpilot-diagnostic/`. |
| `checksums` | SHA-256 per file, keyed by the same relative path. |

### Checksum scheme

- The algorithm is **SHA-256**, computed over the **UTF-8 bytes of the file's
  text content**.
- The digest is recorded **twice**: in `manifest.json` under `checksums`, and
  again in `checksums.json` under `files`. A consumer can verify against either;
  a disagreement between the two is itself a signal that the archive was
  assembled incorrectly or edited.
- `checksums.json` is **not** covered by its own checksum.
- SHA-256 is implemented locally (`hash.ts`) rather than via `crypto.subtle`,
  because `crypto.subtle` is asynchronous and unavailable in insecure contexts —
  it would silently lose checksums for a bundle exported from an HTTP page or a
  page with a restrictive CSP. The implementation is verified against known
  vectors in the tests.

---

## 5. `summary.txt`

The entry point. It is plain text on purpose: it is the file a developer opens
first, often in a viewer with no JSON support, and it must answer "what went
wrong" without opening a multi-megabyte event log.

It contains: version, commit, channel, build time, schema versions; scenario,
session, status, start time, export time; final state, current route, current
job; a **Health** block (storage health or `DEGRADED_READ_ONLY` with the failure
reason, queue owner, whether human verification was encountered); an **Events**
block (recorded, retained, dropped with truncation batch count, critical kept);
a category histogram; and a **Primary failure** block.

The primary failure is selected deterministically, in this order:

1. the first event with level `fatal`;
2. failing that, the first `error.invariant_violation`;
3. failing that, the first event with level `error`.

First, not last: later errors are usually consequences of the first one. If a
fatal error ended the session, its payload is appended under **Fatal error**.

---

## 6. NDJSON files

`events.ndjson` and `state-transitions.ndjson` are **newline-delimited JSON**:

- exactly **one JSON object per line**;
- written **oldest first** — that is, sorted by ascending `sequence`;
- a single trailing newline, and an empty file (not a file containing `[]`) when
  there are no rows.

A consumer must join on **`sequence`**, never on a timestamp. `sequence` is
monotonic within a session and is assigned in one place, so it cannot tie or go
backwards. `monotonicTime` (from `performance.now()`) accompanies `wallTime`
(`Date.now()`) specifically so a race can be reconstructed even if the wall clock
jumps.

Each event object carries `sequence`, `sessionId`, `wallTime`, `monotonicTime`,
`level`, `category`, `event`, and optionally `state`, `jobId`, `queueItemId`,
`transactionId`, `routeId` and `data`.

`level` is one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. `category`
is drawn from the closed `DiagnosticCategory` union in
`src/diagnostics/event.ts`. `event` is a stable, dot-namespaced name from the
`EVENTS` map in the same file — analysis should read `event`, never a rendered
human-readable string, which exists only for the UI.

> **Truncation is evidence, not absence.** The recorder is bounded. When a buffer
> evicts, it emits a `diagnostics.buffer.truncated` event carrying the drop count
> and the buffer name, in position. Critical categories (communication,
> chat-identity, verification, risk, error, lock, storage) are additionally kept
> in a small segregated buffer so a flood of `trace` noise cannot evict the
> record of a send.

---

## 7. Filename convention

`bundleFileName` produces a deterministic, filesystem-safe name:

```
jobpilot-diag_<scenarioId>_<sessionId>_<timestamp>_<buildTag>.zip
```

| Part | Source |
|---|---|
| `scenarioId` | the scenario identifier, e.g. `T44` |
| `sessionId` | e.g. `s20260921T101530-3f9a01` — time-prefixed, so bundles sort chronologically by name, with a random suffix so two sessions in the same millisecond remain distinct |
| `timestamp` | `createdAt` as `YYYYMMDDTHHMMSSZ` |
| `buildTag` | the build identity, e.g. the version and commit |

Each part passes through `sanitizeFileNamePart`, which **allows**
`A–Z a–z 0–9 . _ -` and replaces everything else with `_`, collapses runs of
dots, strips leading and trailing dots and dashes, truncates to 64 characters,
and falls back to `unnamed` for an empty result. It is an allowlist, not a
denylist: a denylist would have to anticipate every traversal and separator
trick, and this string reaches a real filesystem on the preferred export path.
Trailing dots are dropped because Windows silently trims them, which would make
the file not match the name the operator was told to expect.

**Determinism is operational.** The runbook tells the operator exactly which
filename to expect, so a mistyped name is obvious.

---

## 8. A minimal valid bundle

The smallest archive the analyzer should accept. File contents abbreviated here;
in a real bundle each entry is the full text.

```
jobpilot-diagnostic/manifest.json
  {
    "bundleFormatVersion": 1,
    "diagnosticSchemaVersion": 1,
    "redactionPolicyVersion": 1,
    "appVersion": "0.1.0",
    "gitCommit": "unknown",
    "buildTimestamp": "2026-09-21T09:00:00.000Z",
    "channel": "diagnostic",
    "schemaVersion": 4,
    "sessionId": "s20260921T101530-3f9a01",
    "scenarioId": "T44",
    "scenarioName": "chat identity verification",
    "sessionStatus": "completed",
    "createdAt": 1789000530000,
    "files": ["summary.txt", "README.txt", "build.json", "environment.json",
              "session.json", "events.ndjson", "state-transitions.ndjson",
              "errors.json", "storage-summary.json", "config.redacted.json"],
    "checksums": { "summary.txt": "…", "README.txt": "…", "build.json": "…",
                   "environment.json": "…", "session.json": "…",
                   "events.ndjson": "…", "state-transitions.ndjson": "…",
                   "errors.json": "…", "storage-summary.json": "…",
                   "config.redacted.json": "…" }
  }

jobpilot-diagnostic/summary.txt
  JobPilot diagnostic summary
  ===========================
  …
  Primary failure
    none recorded

jobpilot-diagnostic/README.txt
  JobPilot diagnostic bundle
  …

jobpilot-diagnostic/build.json            { "appVersion": "0.1.0", … }
jobpilot-diagnostic/environment.json      { … }
jobpilot-diagnostic/session.json          { "sessionId": "s2026…", "session": { … }, "stats": { … } }
jobpilot-diagnostic/events.ndjson         {"sequence":1,"sessionId":"s2026…",…}\n{"sequence":2,…}\n
jobpilot-diagnostic/state-transitions.ndjson   (may be empty)
jobpilot-diagnostic/errors.json           []
jobpilot-diagnostic/storage-summary.json  { "health": true }
jobpilot-diagnostic/config.redacted.json  { … }
jobpilot-diagnostic/checksums.json        { "algorithm": "sha256", "files": { … } }
```

An operator-visible example of the empty case: a bundle exported before any
failure is expected to have `errors.json` equal to `[]`, a
`state-transitions.ndjson` containing only `state.transition` events (or
nothing), and `Primary failure / none recorded` in `summary.txt`.

### The same layout, as the operator receives it

```
test-results/live/2026-09-21/T44-chat-identity/run-001/
└── jobpilot-diag_T44_s20260921T101530-3f9a01_20260921T101800Z_0.1.0-unknown.zip
```

The ZIP is the outer container; `jobpilot-diagnostic/` is the root **inside** it.
The two naming schemes are different on purpose — the directory is for a human
filing evidence, the filename is for deterministic identification.

---

## 9. Versioning

Two independent versions travel with every bundle:

- `bundleFormatVersion` — the **layout**: which files exist, what shape they
  have, how they are addressed. This document. Currently `1`.
- `redactionPolicyVersion` — the **redaction policy** that sanitised the
  contents, recorded so a reader knows how the evidence was produced.

They version separately because the layout and the policy change for unrelated
reasons.

### How the analyzer must behave

1. Read `manifest.json` **first**. If it is absent or unparseable, refuse the
   bundle: `not a JobPilot diagnostic bundle`.
2. If `bundleFormatVersion` is **greater than** the version the analyzer
   understands, **refuse to analyse and say so explicitly**. Do not attempt a
   best-effort parse. A newer format may have moved meaning between files, and a
   partial read would produce a confident-looking but wrong report.
3. If `bundleFormatVersion` is **lower than** the analyzer's version, analyse it
   using the older layout rules, and say in the report which format version was
   read.
4. If `redactionPolicyVersion` differs from the analyzer's, note it in the
   report. A change in the policy can change what is present.
5. Verify every entry listed in `files` exists and that each SHA-256 in
   `checksums` matches the file's content. A mismatch is a hard failure: the
   evidence is not the evidence that was exported.
6. Report `gitCommit: "unknown"` as such. It means git was unavailable at build
   time — it is never a fabricated value.

`pnpm diag:selftest` exists to exercise steps 1–5 against known-good and
deliberately-corrupted bundles.

---

## 10. Limits and failure modes

| Condition | Behaviour |
|---|---|
| An entry path is unsafe (absolute, contains `\`, `.` or `..`, empty segment, >512 chars) | `createZip` **throws** `unsafe zip entry path` |
| A single entry exceeds `MAX_ENTRY_BYTES` (4 GiB − 1) | `createZip` **throws** `zip entry too large` |
| The archive exceeds `MAX_TOTAL_BYTES` | `createZip` **throws** `zip archive too large for the non-ZIP64 format` |
| An event payload is not JSON-serialisable | the recorder drops the offending keys before the event is stored, so it cannot reach ZIP time |
| A value is sensitive | it never enters a buffer, so it cannot appear in any file — see [`PRIVACY.md`](./PRIVACY.md) |
| A timestamp predates 1980 | the DOS date is clamped rather than wrapped |

These failures are intentionally loud. A bundle that is corrupt is discovered
immediately at export, rather than by an analyzer that reports on evidence it
cannot actually read.

---

## 11. Reader

`readZip` in `zip.ts` is a store-only reader that exists so tests can prove a
generated bundle is **genuinely readable** by a third party, not merely
well-formed by its own writer. An archive only our writer understood would fail
at exactly the moment it is needed. It locates the end-of-central-directory
record by scanning backwards (allowing for a trailing comment), walks the central
directory, rejects any compression method other than store, and reads each entry
by seeking to its local header — tolerating a differing local name/extra length,
which is a known place for a hostile archive to hide data.
