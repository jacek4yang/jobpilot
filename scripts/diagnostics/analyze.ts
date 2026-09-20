/**
 * Pattern detection.
 *
 * Turns an event stream into findings. The governing rule from the brief:
 * do not invent a diagnosis when the evidence is insufficient. Every finding
 * therefore carries a confidence of `confirmed`, `likely` or `unknown`, and
 * every finding cites the sequence numbers it was derived from so a reader can
 * check the reasoning rather than trusting it.
 *
 * "confirmed" means the evidence directly demonstrates the claim — a required
 * event is absent, or two events contradict each other. "likely" means the
 * evidence is consistent with the claim but an alternative explanation remains.
 * "unknown" is recorded explicitly so that a gap in coverage is visible rather
 * than looking like a clean run.
 */
import type { DiagnosticEvent } from "../../src/diagnostics/event";

export type Confidence = "confirmed" | "likely" | "unknown";

export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly confidence: Confidence;
  /** Why the evidence supports this, in one or two sentences. */
  readonly detail: string;
  /** Sequence numbers the finding was derived from. */
  readonly evidence: readonly number[];
  /** What to look at next. */
  readonly nextStep: string;
}

const seq = (event: DiagnosticEvent | undefined): number => event?.sequence ?? 0;

const findByEvent = (events: readonly DiagnosticEvent[], name: string): DiagnosticEvent[] =>
  events.filter((event) => event.event === name);

const sorted = (events: readonly DiagnosticEvent[]): readonly DiagnosticEvent[] =>
  [...events].sort((a, b) => a.sequence - b.sequence);

/**
 * Detects the selector failures that are the most common real-site breakage.
 */
const analyzeSelectors = (events: readonly DiagnosticEvent[]): Finding[] => {
  const findings: Finding[] = [];
  const misses = findByEvent(events, "selector.miss");
  const ambiguous = findByEvent(events, "selector.ambiguous");
  const matches = findByEvent(events, "selector.match");

  if (misses.length > 0) {
    // Group by the `purpose` field so a single broken target is one finding,
    // not one finding per attempt.
    const byPurpose = new Map<string, DiagnosticEvent[]>();
    for (const event of misses) {
      const purpose =
        typeof event.data?.["purpose"] === "string" ? (event.data["purpose"] as string) : "unknown";
      const bucket = byPurpose.get(purpose) ?? [];
      bucket.push(event);
      byPurpose.set(purpose, bucket);
    }

    for (const [purpose, occurrences] of byPurpose) {
      const confirmed = occurrences.length >= 2;
      findings.push({
        id: `selector.miss.${purpose}`,
        title: `Selector target never matched: ${purpose}`,
        confidence: confirmed ? "confirmed" : "likely",
        detail: confirmed
          ? `No candidate matched "${purpose}" on ${occurrences.length} separate attempts, which rules out a transient render race.`
          : `"${purpose}" failed to match once. A single miss can be a render race rather than a layout change.`,
        evidence: occurrences.map(seq),
        nextStep:
          "Open selector-report.md and check the page fingerprint: a changed fingerprint means the layout moved, an unchanged one means the target render is late.",
      });
    }
  }

  if (ambiguous.length > 0) {
    findings.push({
      id: "selector.ambiguous",
      title: "Ambiguous selector matches",
      confidence: "confirmed",
      detail: `${ambiguous.length} selector target(s) matched more than one visible element, so JobPilot refused to guess which to use.`,
      evidence: ambiguous.map(seq),
      nextStep:
        "Inspect dom-diagnostics.json for the nearby elements and tighten the candidate to a semantic anchor.",
    });
  }

  if (misses.length === 0 && ambiguous.length === 0) {
    findings.push({
      id: "selector.clean",
      title: "No selector failures recorded",
      // Not "confirmed working on the live site" — only that nothing failed here.
      confidence: matches.length > 0 ? "likely" : "unknown",
      detail:
        matches.length > 0
          ? `${matches.length} selector match(es) recorded with no misses or ambiguities.`
          : "No selector activity was recorded at all, so this bundle does not cover selector behaviour.",
      evidence: [],
      nextStep:
        "If the scenario was expected to exercise selectors, raise the diagnostic level and repeat.",
    });
  }

  return findings;
};

/** Detects transaction-level problems, which are the safety-critical class. */
const analyzeTransactions = (events: readonly DiagnosticEvent[]): Finding[] => {
  const findings: Finding[] = [];
  const ordered = sorted(events);

  const attempts = findByEvent(ordered, "communication.send.attempted");
  const clicks = findByEvent(ordered, "communication.send.clicked");
  const verifyStarts = findByEvent(ordered, "communication.verification.started");
  const committed = findByEvent(ordered, "communication.transaction.committed");
  const uncertain = findByEvent(ordered, "communication.transaction.uncertain");
  const failed = findByEvent(ordered, "communication.transaction.failed");

  const drafts = findByEvent(ordered, "message.draft.checked").filter(
    (event) => event.data?.["draftPresent"] === true,
  );
  const identityRejected = findByEvent(ordered, "chat.identity.rejected");

  // A verification started without an attempt means the send was never observed
  // to be dispatched, which is either a bug or a mis-ordered trace.
  for (const verification of verifyStarts) {
    const attemptBefore = attempts.some((attempt) => attempt.sequence < verification.sequence);
    if (!attemptBefore) {
      findings.push({
        id: "transaction.verify-without-attempt",
        title: "Verification started without a recorded send attempt",
        confidence: "confirmed",
        detail:
          "The transaction began verifying before any send attempt was persisted. A verification must always follow a persisted attempt, or the outcome cannot be trusted.",
        evidence: [seq(verification)],
        nextStep:
          "Check whether the attempt event was lost to buffer truncation, then inspect send-attempt ordering.",
      });
    }
  }

  // A click with no persisted attempt is the single most serious ordering fault.
  for (const click of clicks) {
    const attemptBefore = attempts.some((attempt) => attempt.sequence < click.sequence);
    if (!attemptBefore) {
      findings.push({
        id: "transaction.click-without-intent",
        title: "Send clicked without a persisted attempt",
        confidence: "confirmed",
        detail:
          "A send was clicked before the point of no return was persisted, so a crash at that moment would have been unrecoverable.",
        evidence: [seq(click)],
        nextStep:
          "This is an invariant violation. Check the ordering around communication.send.attempt.persisted.",
      });
    }
  }

  // More than one attempt for the SAME transaction is a duplicate-send signal.
  // Correlating on `transactionId` is essential: two attempts in two different
  // transactions is the normal case, and reporting it as a violation would be a
  // false positive of exactly the kind this analyzer must not produce.
  const attemptsByTransaction = new Map<string, DiagnosticEvent[]>();
  for (const attempt of attempts) {
    const id = attempt.transactionId ?? "(no transaction id)";
    const bucket = attemptsByTransaction.get(id) ?? [];
    bucket.push(attempt);
    attemptsByTransaction.set(id, bucket);
  }

  for (const [transactionId, repeated] of attemptsByTransaction) {
    if (repeated.length <= 1) continue;
    const identified = transactionId !== "(no transaction id)";
    findings.push({
      id: `transaction.multiple-attempts.${transactionId}`,
      title: "More than one send attempt for one transaction",
      // Without an id the events cannot be proven to belong to one
      // transaction, so the claim is downgraded rather than asserted.
      confidence: identified ? "confirmed" : "unknown",
      detail: identified
        ? `Transaction ${transactionId} recorded ${repeated.length} send attempts. At most one is permitted per transaction.`
        : `${repeated.length} send attempts carried no transaction id, so they may or may not belong to one transaction.`,
      evidence: repeated.map(seq),
      nextStep:
        "Inspect transactions.json for this transaction id and check the never-send-twice guard.",
    });
  }

  // A transaction reaching both terminal outcomes is also per-transaction.
  const terminalByTransaction = new Map<string, Set<string>>();
  for (const event of [...committed, ...uncertain, ...failed]) {
    const id = event.transactionId ?? "(no transaction id)";
    const set = terminalByTransaction.get(id) ?? new Set<string>();
    set.add(event.event);
    terminalByTransaction.set(id, set);
  }

  for (const [transactionId, outcomes] of terminalByTransaction) {
    if (outcomes.size <= 1) continue;
    findings.push({
      id: `transaction.mixed-outcome.${transactionId}`,
      title: "Transaction reported more than one terminal outcome",
      confidence: transactionId === "(no transaction id)" ? "unknown" : "confirmed",
      detail: `Transaction ${transactionId} reached conflicting terminal states: ${[...outcomes].join(", ")}. Exactly one terminal outcome is expected per transaction.`,
      evidence: [...committed, ...uncertain, ...failed]
        .filter((event) => (event.transactionId ?? "(no transaction id)") === transactionId)
        .map(seq),
      nextStep: "Treat the job as contacted and inspect transactions.json before any retry.",
    });
  }

  if (uncertain.length > 0) {
    findings.push({
      id: "transaction.uncertain",
      title: "A send outcome could not be determined",
      confidence: "confirmed",
      detail:
        "A send was dispatched but no outgoing message was observed. The transaction is unresolved and must not be resent automatically.",
      evidence: uncertain.map(seq),
      nextStep: "Check the conversation manually. Do not re-run this job until it is resolved.",
    });
  }

  if (drafts.length > 0) {
    findings.push({
      id: "transaction.draft-present",
      title: "An existing draft blocked a send",
      confidence: "confirmed",
      detail:
        "Unsent text was present in the conversation, so JobPilot left it untouched and stopped. This is the intended behaviour.",
      evidence: drafts.map(seq),
      nextStep: "No action needed for safety; if unexpected, check who typed into the editor.",
    });
  }

  if (identityRejected.length > 0) {
    findings.push({
      id: "transaction.identity-rejected",
      title: "Chat identity was rejected",
      confidence: "confirmed",
      detail: `${identityRejected.length} conversation(s) failed identity verification, so nothing was written into them.`,
      evidence: identityRejected.map(seq),
      nextStep:
        "Compare the identity signals in transactions.json against the job: a changed chat header format looks like this.",
    });
  }

  // State the detector's own blind spot.
  //
  // Every per-transaction claim above relies on `transactionId`. When the
  // stream carries communication events without one, the analysis degrades
  // silently: findings still appear, but they cannot be correlated. Saying so
  // explicitly is the difference between "we found nothing" and "we could not
  // look", and only one of those is safe to act on.
  const transactionEvents = ordered.filter((event) => event.event.startsWith("communication."));
  const unidentified = transactionEvents.filter((event) => event.transactionId === undefined);
  if (transactionEvents.length > 0 && unidentified.length > 0) {
    findings.push({
      id: "transaction.coverage-gap",
      title: "Some communication events carry no transaction id",
      // The gap is an observation; its cause is not established.
      confidence: "likely",
      detail: `${unidentified.length} of ${transactionEvents.length} communication event(s) have no transactionId, so per-transaction correlation is incomplete. Duplicate-send and mixed-outcome claims cannot be relied on for those events.`,
      evidence: unidentified.slice(0, 20).map(seq),
      nextStep:
        "Check that the runner and the service stamp transactionId on every communication event. Until they do, treat the absence of a duplicate-send finding as unproven rather than as evidence of correctness.",
    });
  }

  return findings;
};

/** Detects stalls, retries and health problems. */
const analyzeHealth = (events: readonly DiagnosticEvent[]): Finding[] => {
  const findings: Finding[] = [];

  const stalls = findByEvent(events, "effect.timed_out");
  if (stalls.length > 0) {
    const byEffect = new Map<string, DiagnosticEvent[]>();
    for (const event of stalls) {
      const name =
        typeof event.data?.["effect"] === "string"
          ? (event.data["effect"] as string)
          : String(event.event);
      const bucket = byEffect.get(name) ?? [];
      bucket.push(event);
      byEffect.set(name, bucket);
    }
    for (const [effect, occurrences] of byEffect) {
      findings.push({
        id: `health.timeout.${effect}`,
        title: `Effect timed out: ${effect}`,
        confidence: occurrences.length >= 2 ? "confirmed" : "likely",
        detail:
          occurrences.length >= 2
            ? `${effect} timed out ${occurrences.length} times, which points at a systematic cause rather than a slow render.`
            : `${effect} timed out once.`,
        evidence: occurrences.map(seq),
        nextStep:
          "Compare the recorded duration against the configured budget before raising it; a longer timeout may hide a real failure.",
      });
    }
  }

  const watchdog = findByEvent(events, "watchdog.stalled");
  if (watchdog.length > 0) {
    findings.push({
      id: "health.watchdog",
      title: "The watchdog fired",
      confidence: "confirmed",
      detail: `A state exceeded its budget ${watchdog.length} time(s), meaning work stopped progressing.`,
      evidence: watchdog.map(seq),
      nextStep:
        "Correlate the stall time with the route timeline: a route change during an action is the usual cause.",
    });
  }

  const storageFailures = findByEvent(events, "storage.read.failed").concat(
    findByEvent(events, "storage.write.failed"),
  );
  if (storageFailures.length > 0) {
    // The detector must only claim what it checked. It knows storage failed; it
    // does NOT know whether a send followed, so it looks — rather than
    // asserting the second half and telling the reader to go and verify it.
    const firstFailure = storageFailures[0];
    const sendsAfterFailure =
      firstFailure === undefined
        ? []
        : events.filter(
            (event) =>
              event.sequence > firstFailure.sequence &&
              event.event.startsWith("communication.send."),
          );

    if (sendsAfterFailure.length > 0) {
      findings.push({
        id: "health.storage",
        title: "Persistence failed and a send followed",
        // This is the dangerous combination: duplicate-prevention state could
        // not be recorded, yet a send was attempted anyway.
        confidence: "confirmed",
        detail: `${storageFailures.length} storage operation(s) failed, and ${sendsAfterFailure.length} send event(s) followed the first failure at sequence ${firstFailure?.sequence ?? 0}. The storage-health gate did not hold.`,
        evidence: [...storageFailures.map(seq), ...sendsAfterFailure.map(seq)],
        nextStep:
          "This is an invariant violation. Check why the storage-health gate allowed a send after persistence failed.",
      });
    } else {
      findings.push({
        id: "health.storage",
        title: "Persistence failed",
        confidence: "confirmed",
        // States only what was observed: no send follows the failure.
        detail: `${storageFailures.length} storage operation(s) failed. No send event follows the first failure, which is the expected fail-closed behaviour.`,
        evidence: storageFailures.map(seq),
        nextStep: "Check storage-summary.json for the cause, then confirm storage recovers.",
      });
    }
  }

  const lockLost = findByEvent(events, "lock.lease.expired").concat(
    findByEvent(events, "lock.rejected"),
  );
  if (lockLost.length > 0) {
    findings.push({
      id: "health.lock",
      title: "Queue ownership was lost or refused",
      confidence: "confirmed",
      detail:
        "Lock events indicate this tab did not own the queue, or lost it. Only the owner may drive execution.",
      evidence: lockLost.map(seq),
      nextStep:
        "Check whether another tab was open. Two tabs driving one queue is a duplicate-send risk.",
    });
  }

  const truncation = findByEvent(events, "diagnostics.buffer.truncated");
  if (truncation.length > 0) {
    const dropped = truncation.reduce((total, event) => {
      const value = event.data?.["dropped"];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
    findings.push({
      id: "health.truncated",
      title: "Diagnostic buffers were truncated",
      confidence: "confirmed",
      detail: `${dropped} event(s) were dropped under buffer pressure, so this bundle is an incomplete record.`,
      evidence: truncation.map(seq),
      nextStep:
        "Critical communication events are kept separately, so check criticalEvents coverage before concluding anything from an absence.",
    });
  }

  const risk = events.filter(
    (event) =>
      event.event === "risk.captcha.detected" ||
      event.event === "risk.login.detected" ||
      event.event === "risk.security_verification.detected" ||
      event.event === "risk.risk_control.detected",
  );
  if (risk.length > 0) {
    findings.push({
      id: "health.human-verification",
      title: "Human verification was encountered",
      confidence: "confirmed",
      detail: `${risk.length} verification event(s). JobPilot must have stopped and never interacted with the challenge.`,
      evidence: risk.map(seq),
      nextStep:
        "Verify no send or click event follows the detection without an intervening explicit resume.",
    });
  }

  const invariantViolations = findByEvent(events, "error.invariant_violation");
  if (invariantViolations.length > 0) {
    findings.push({
      id: "health.invariant-violation",
      title: "A production invariant was violated",
      // Fatal by definition: the whole safety model depends on these holding.
      confidence: "confirmed",
      detail: invariantViolations
        .map((event) => String(event.data?.["invariant"] ?? "unknown"))
        .join(", "),
      evidence: invariantViolations.map(seq),
      nextStep:
        "Treat as a release blocker. Fix the root cause and add a regression test before continuing.",
    });
  }

  return findings;
};

/** Detects routes changing while an action was in flight. */
const analyzeRoutes = (events: readonly DiagnosticEvent[]): Finding[] => {
  const ordered = sorted(events);
  const changes = findByEvent(ordered, "route.changed");
  const findings: Finding[] = [];

  for (const change of changes) {
    // An effect that started before the change and completed after it was
    // operating on a page that no longer exists.
    const started = ordered.filter(
      (event) => event.event === "effect.started" && event.sequence < change.sequence,
    );
    const lastStarted = started.at(-1);
    if (lastStarted === undefined) continue;

    const completedAfter = ordered.find(
      (event) =>
        event.event === "effect.completed" &&
        event.sequence > change.sequence &&
        event.data?.["effect"] === lastStarted.data?.["effect"],
    );

    if (completedAfter !== undefined) {
      findings.push({
        id: `route.change-during-${String(lastStarted.data?.["effect"])}`,
        title: "Route changed while an effect was in flight",
        confidence: "likely",
        detail: `"${String(lastStarted.data?.["effect"])}" began before the route changed and completed after it, so it may have acted on a stale page.`,
        evidence: [seq(lastStarted), seq(change), seq(completedAfter)],
        nextStep:
          "Check dom-diagnostics for a detached or replaced element, and consider whether the effect should abort on route change.",
      });
    }
  }

  return findings;
};

/** Queue lifecycle problems. */
const analyzeQueue = (events: readonly DiagnosticEvent[]): Finding[] => {
  const findings: Finding[] = [];
  const ordered = sorted(events);

  const enqueued = findByEvent(ordered, "queue.item.enqueued");
  const started = findByEvent(ordered, "queue.item.started");

  const startedIds = new Set(started.map((event) => event.queueItemId).filter(Boolean));
  const enqueuedIds = new Set(enqueued.map((event) => event.queueItemId).filter(Boolean));

  const startedWithoutEnqueue = [...startedIds].filter((id) => !enqueuedIds.has(id));
  if (startedWithoutEnqueue.length > 0) {
    findings.push({
      id: "queue.start-without-enqueue",
      title: "A queue item started without being enqueued",
      confidence: "likely",
      detail: `${startedWithoutEnqueue.length} item(s) started with no matching enqueue event. This can be a restored-from-storage item, which is legitimate, or a bookkeeping gap.`,
      evidence: started
        .filter((event) => startedWithoutEnqueue.includes(event.queueItemId ?? ""))
        .map(seq),
      nextStep: "Check the startup events for a queue restore before treating this as a fault.",
    });
  }

  // A queue item started more than once is suspicious but NOT on its own proof
  // of duplicate processing: a restore after a reload legitimately re-starts an
  // item that was interrupted. What distinguishes the two is whether the item
  // SETTLED in between — an item that completed and then started again is a
  // genuine re-run, while one interrupted mid-flight and resumed is normal.
  const settled = findByEvent(ordered, "queue.item.completed")
    .concat(
      findByEvent(ordered, "queue.item.failed"),
      findByEvent(ordered, "queue.item.skipped"),
      findByEvent(ordered, "queue.item.blocked"),
    )
    .map((event) => event.queueItemId)
    .filter((id): id is string => id !== undefined);

  const duplicateStarts = new Map<string, DiagnosticEvent[]>();
  for (const event of started) {
    const id = event.queueItemId;
    if (id === undefined) continue;
    const bucket = duplicateStarts.get(id) ?? [];
    bucket.push(event);
    duplicateStarts.set(id, bucket);
  }

  for (const [id, restarts] of duplicateStarts) {
    if (restarts.length <= 1) continue;
    const reRan = settled.includes(id);

    findings.push({
      id: `queue.duplicate-processing.${id}`,
      title: reRan
        ? "A settled queue item was started again"
        : "A queue item was started more than once",
      // Only a settled-then-restarted item is provably a re-run. Otherwise the
      // most likely explanation is a restore, and asserting a fault would send
      // the reader hunting for duplicate communication that never happened.
      confidence: reRan ? "confirmed" : "likely",
      detail: reRan
        ? `Item ${id} settled and was then started again. That is a genuine re-run and risks duplicate communication.`
        : `Item ${id} was started ${restarts.length} times without settling in between, which is consistent with a restore after a reload rather than a re-run.`,
      evidence: restarts.map(seq),
      nextStep: reRan
        ? "Check the lock timeline: a lost lease allows a second tab to take over mid-item."
        : "Check for a queue restore event before treating this as a fault.",
    });
  }

  return findings;
};

export interface AnalysisResult {
  readonly findings: readonly Finding[];
  /**
   * First error-level event, which is usually the cause rather than a symptom.
   *
   * Declared `| undefined` because a clean run legitimately has none, and
   * under `exactOptionalPropertyTypes` an optional property cannot be assigned
   * an explicit `undefined`.
   */
  readonly firstFailure?: DiagnosticEvent | undefined;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Runs every detector over the event stream.
 *
 * Findings are ordered by severity: invariant violations and confirmed
 * transaction faults first, then selector and health problems, then the softer
 * route and queue observations.
 */
export const analyzeEvents = (events: readonly DiagnosticEvent[]): AnalysisResult => {
  const ordered = sorted(events);

  const findings: Finding[] = [
    ...analyzeTransactions(ordered),
    ...analyzeHealth(ordered),
    ...analyzeSelectors(ordered),
    ...analyzeRoutes(ordered),
    ...analyzeQueue(ordered),
  ];

  const severity = (finding: Finding): number => {
    if (finding.id === "health.invariant-violation") return 0;
    if (finding.id.startsWith("transaction.") && finding.confidence === "confirmed") return 1;
    if (finding.id === "health.storage" || finding.id === "health.lock") return 2;
    if (finding.confidence === "confirmed") return 3;
    if (finding.confidence === "likely") return 4;
    return 5;
  };

  findings.sort((a, b) => severity(a) - severity(b));

  const counts: Record<string, number> = {};
  for (const event of ordered) {
    counts[event.category] = (counts[event.category] ?? 0) + 1;
  }

  // The first error is the useful one; later errors are usually its
  // consequences, which is why this is reported separately from the list.
  const firstFailure = ordered.find((event) => event.level === "error" || event.level === "fatal");

  return { findings, firstFailure, counts };
};
