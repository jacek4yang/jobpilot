/**
 * Diagnostic session.
 *
 * A session is an explicit, operator-scoped unit of evidence. Without one, a
 * bundle mixes several test attempts together and the first-divergence analysis
 * cannot attribute a failure to a scenario.
 *
 * A session is started deliberately, never on page load. Events recorded before
 * a session starts are kept under a synthetic `pre-session` id so a crash during
 * startup is still captured.
 */

import type { BuildInfo } from "./build-info";

export type SessionStatus = "running" | "completed" | "failed" | "blocked" | "aborted";

export interface DiagnosticSession {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly build: BuildInfo;
  readonly status: SessionStatus;
  readonly operatorNotes?: string;
}

/** Session id used before the operator starts a named session. */
export const PRE_SESSION_ID = "pre-session";

export interface StartSessionInput {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly startedAt: number;
  readonly build: BuildInfo;
  readonly operatorNotes?: string;
}

export const startSession = (input: StartSessionInput): DiagnosticSession => ({
  id: input.id,
  scenarioId: input.scenarioId,
  scenarioName: input.scenarioName,
  startedAt: input.startedAt,
  build: input.build,
  status: "running",
  ...(input.operatorNotes === undefined ? {} : { operatorNotes: input.operatorNotes }),
});

export const finishSession = (
  session: DiagnosticSession,
  status: Exclude<SessionStatus, "running">,
  finishedAt: number,
): DiagnosticSession => ({ ...session, status, finishedAt });

export const isSessionOpen = (session: DiagnosticSession): boolean => session.status === "running";

/**
 * Generates a session id.
 *
 * Time-prefixed so bundles sort chronologically by filename, with randomness so
 * two sessions in the same millisecond are still distinct.
 */
export const newSessionId = (now: number, random: () => number = Math.random): string => {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const suffix = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `s${stamp}-${suffix}`;
};

/**
 * Neutralises a Windows reserved device name.
 *
 * Windows resolves the part BEFORE the first dot against the device list, so
 * both `NUL` and `NUL.txt` are unusable, and appending a suffix to the whole
 * string (`NUL.txt_file`) does not help because the base is still `NUL`. The
 * prefix must therefore be applied to the BASE name, ahead of any extension.
 */
const neutraliseReserved = (name: string): string => {
  const dot = name.indexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot);
  return RESERVED_BASE.test(base) ? `${base}_file${extension}` : name;
};

/**
 * Windows reserved device names, matched against a base name only.
 *
 * The bundled filename always carries a prefix so this is not reachable through
 * `bundleFileName`, but `sanitizeFileNamePart` is a general helper and its
 * contract is that its output is a safe path segment.
 */
const RESERVED_BASE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Makes an arbitrary string safe to embed in a filename.
 *
 * Rejects anything outside a conservative allowlist rather than trying to strip
 * known-bad sequences: a denylist would have to anticipate every traversal and
 * separator trick, and this string reaches a real filesystem on the preferred
 * export path.
 *
 * Trailing dots are also dropped, because Windows silently trims them and the
 * resulting file would not match the name the operator was told to expect.
 */
export const sanitizeFileNamePart = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
  const trimmed = cleaned.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  if (trimmed.length === 0) return "unnamed";
  return neutraliseReserved(trimmed).slice(0, 64);
};

/**
 * Deterministic, filesystem-safe bundle filename.
 *
 * Determinism matters operationally: the runbook tells the operator exactly
 * which file to expect, so a mistyped name is obvious.
 */
export const bundleFileName = (input: {
  readonly scenarioId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly buildTag: string;
}): string => {
  const scenario = sanitizeFileNamePart(input.scenarioId);
  const session = sanitizeFileNamePart(input.sessionId);
  const tag = sanitizeFileNamePart(input.buildTag);
  const stamp = new Date(input.createdAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `jobpilot-diag_${scenario}_${session}_${stamp}_${tag}.zip`;
};

/**
 * Builds a `YYYY-MM-DD` directory name in LOCAL time.
 *
 * Local rather than UTC because the operator files bundles by the date they
 * ran the test, which is what their calendar shows.
 */
export const localDateDirectory = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
